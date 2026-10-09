import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchbackClient } from '@switchback/client';
import { createTransportPair, type EngineEvent } from '@switchback/protocol';
import { type Provider, ProviderError, type Script, ScriptedProvider } from '@switchback/providers';
import { loadAgents, parseAgentFile } from './agents.ts';
import { SwitchbackConfig } from './config.ts';
import { Engine, type EngineOptions } from './engine.ts';
import { serve } from './server.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-test-'));
  writeFileSync(join(root, 'hello.txt'), 'hello world\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(
  local: Script,
  remote: Script,
  { config: overrides, ...opts }: Partial<Omit<EngineOptions, 'config'>> & { config?: object } = {},
) {
  const config = SwitchbackConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
    models: {
      local: { provider: 'lp', model: 'small', contextWindow: 8_000 },
      remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
    },
    permissions: { edit: 'allow', bash: 'deny' },
    ...overrides,
    routing: {
      start: ['local'],
      escalate: [['remote']],
      ...(overrides as { routing?: object } | undefined)?.routing,
    },
  });
  const lp = new ScriptedProvider('lp', 'local', local);
  const rp = new ScriptedProvider('rp', 'remote', remote);
  const engine = new Engine({
    workspaceRoot: root,
    config,
    providers: new Map([
      ['lp', lp],
      ['rp', rp],
    ]),
    ...opts,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, lp, rp, events };
}

describe('Engine', () => {
  test('answers locally by default and records zero cost with savings', async () => {
    const { engine, lp, rp, events } = setup([{ text: 'hi there' }], []);
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'hello');
    expect(r).toEqual({ stopReason: 'end_turn', text: 'hi there' });
    expect(lp.requests).toHaveLength(1);
    expect(rp.requests).toHaveLength(0);
    const route = events.find((e) => e.type === 'route.decided');
    expect(route).toMatchObject({ tier: 'local', rule: 'default' });
    const usage = engine.usage();
    expect(usage.byTier.remote.costUsd).toBe(0);
    expect(usage.estimatedSavingsUsd).toBeGreaterThan(0);
  });

  test('uses the context window the server reports when config leaves it out', async () => {
    const config = SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
      models: {
        local: { provider: 'lp', model: 'small' },
        remote: { provider: 'rp', model: 'big' },
      },
      routing: { start: ['local'], escalate: [['remote']] },
    });
    const lp = Object.assign(new ScriptedProvider('lp', 'local', [{ text: 'local' }]), {
      contextWindow: async () => ({ contextWindow: 1_000, source: 'test' }),
    });
    const rp = new ScriptedProvider('rp', 'remote', [{ text: 'remote' }]);
    const engine = new Engine({
      workspaceRoot: root,
      config,
      providers: new Map<string, Provider>([
        ['lp', lp],
        ['rp', rp],
      ]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const s = engine.createSession({});
    // ~1,500 tokens of prompt: over 85% of the detected 1,000-token window.
    const r = await engine.runTurn(s.id, 'x'.repeat(6_000));
    expect(r.text).toBe('remote');
    expect(events.find((e) => e.type === 'route.decided')).toMatchObject({
      rule: 'context-overflow',
    });
    expect(events.some((e) => e.type === 'log' && e.message.includes('context window 1000'))).toBe(
      true,
    );
  });

  test('asks for no more output than the known window has room for', async () => {
    const maxTokensFor = async (model: Record<string, unknown>) => {
      const config = SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' } },
        models: { m: { provider: 'lp', model: 'small', ...model } },
        routing: { start: ['m'] },
      });
      const lp = Object.assign(new ScriptedProvider('lp', 'local', [{ text: 'a' }]), {
        contextWindow: async () => ({ contextWindow: 6_000, source: 'test' }),
      });
      const engine = new Engine({
        workspaceRoot: root,
        config,
        providers: new Map<string, Provider>([['lp', lp]]),
      });
      await engine.runTurn(engine.createSession({}).id, 'hi');
      return lp.requests[0]?.maxTokens ?? 0;
    };
    // The detected 6,000-token window, not the 16,000 default (which vLLM would reject).
    const detected = await maxTokensFor({});
    expect(detected).toBeLessThan(6_000);
    // Less what the prompt and tool list take.
    expect(detected).toBeGreaterThan(3_000);
    // A configured cap under the window stands.
    expect(await maxTokensFor({ contextWindow: 32_000, maxOutputTokens: 2_000 })).toBe(2_000);
  });

  test('@mentions attach workspace files, and only those', async () => {
    const { engine, lp } = setup([{ text: 'seen' }], []);
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'explain @hello.txt, @missing.ts and @../../etc/passwd');
    const parts = lp.requests[0]?.messages[0]?.parts ?? [];
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({
      type: 'text',
      text: '<file path="hello.txt">\nhello world\n\n</file>',
      attachment: { path: 'hello.txt' },
    });
  });

  test('client attachments become attachment parts (files confined to the workspace)', async () => {
    const { engine, lp } = setup([{ text: 'ok' }], []);
    const s = engine.createSession({});
    writeFileSync(join(root, 'code.ts'), 'a\nb\nc\nd\n');
    await engine.runTurn(s.id, 'explain', 'auto', undefined, undefined, [
      { kind: 'file', path: 'code.ts', startLine: 2, endLine: 3 },
      { kind: 'text', label: 'Problems', text: 'code.ts:2 error: nope' },
      { kind: 'file', path: '../../etc/passwd' },
    ]);
    const parts = lp.requests[0]?.messages[0]?.parts ?? [];
    expect(parts.slice(1)).toEqual([
      {
        type: 'text',
        text: '<file path="code.ts" lines="2-3">\nb\nc\n</file>',
        attachment: { path: 'code.ts:2-3' },
      },
      {
        type: 'text',
        text: '<context label="Problems">\ncode.ts:2 error: nope\n</context>',
        attachment: { path: 'Problems' },
      },
    ]);
  });

  test('runs tools and feeds results back', async () => {
    const { engine, lp } = setup(
      [
        { toolCalls: [{ name: 'read', input: { path: 'hello.txt' } }] },
        { text: 'it says hello world' },
      ],
      [],
    );
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'what is in hello.txt?');
    expect(r.text).toBe('it says hello world');
    const second = lp.requests[1];
    const toolResult = second?.messages.at(-1)?.parts[0];
    expect(toolResult).toMatchObject({ type: 'tool_result' });
    expect((toolResult as { content: string }).content).toContain('hello world');
  });

  test('escalates to remote after repeated malformed tool calls, then resolves', async () => {
    const { engine, rp, events } = setup(
      [
        { toolCalls: [{ name: 'read', input: { nope: 1 } }] },
        { toolCalls: [{ name: 'reed', input: {} }] },
      ],
      [{ text: 'fixed it remotely' }],
    );
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'do the thing');
    expect(r.text).toBe('fixed it remotely');
    expect(rp.requests).toHaveLength(1);
    const routes = events
      .filter((e) => e.type === 'route.decided')
      .map((e) => (e as { rule: string }).rule);
    expect(routes).toEqual(['default', 'default', 'escalation']);
    expect(engine.usage().byTier.remote.costUsd).toBeGreaterThan(0);
  });

  test('climbs through a bigger local model (escalation.via) before going remote', async () => {
    const bad = (name: string) => ({ toolCalls: [{ name, input: {} }] });
    const lp = new ScriptedProvider('lp', 'local', [bad('reed'), bad('reed')]);
    const gp = new ScriptedProvider('gp', 'local', [bad('raed'), bad('raed')]);
    const rp = new ScriptedProvider('rp', 'remote', [{ text: 'fixed it remotely' }]);
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: {
          lp: { type: 'mock', tier: 'local' },
          gp: { type: 'mock', tier: 'local' },
          rp: { type: 'mock', tier: 'remote' },
        },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow: 8_000 },
          large: { provider: 'gp', model: 'large', contextWindow: 128_000 },
          remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
        },
        routing: { start: ['local'], escalate: ['large', 'remote'] },
        permissions: { edit: 'allow', bash: 'deny' },
      }),
      providers: new Map([
        ['lp', lp],
        ['gp', gp],
        ['rp', rp],
      ]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'do the thing');
    expect(r.text).toBe('fixed it remotely');
    const routes = events.flatMap((e) =>
      e.type === 'route.decided' ? [`${e.rule}:${e.model.model}`] : [],
    );
    expect(routes).toEqual([
      'default:small',
      'default:small',
      'escalation:large',
      'sticky:large',
      'escalation:claude-opus-5',
    ]);
    expect(gp.requests).toHaveLength(2);
    // The local step is free; only the last step costs anything.
    expect(engine.usage().byTier.remote.costUsd).toBeGreaterThan(0);
  });

  test('falls back to remote when the local provider errors', async () => {
    const { engine, rp } = setup(
      [{ error: new ProviderError('connection refused', 'lp', true) }],
      [{ text: 'remote answer' }],
    );
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'hi');
    expect(r.text).toBe('remote answer');
    expect(rp.requests).toHaveLength(1);
  });

  test('never replays reasoning from another model', async () => {
    const { engine } = setup([{ text: 'local' }], []);
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'hi');
    // The neutral transcript keeps everything; filtering happens in the provider adapters.
    expect(engine.getSession(s.id).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  test('subagents run in child sessions and report back to the parent', async () => {
    const { engine, events, lp } = setup((req) => {
      // The explore subagent is pinned local; its prompt starts with its own system text.
      if (req.system.includes('read-only search agent')) return { text: 'found it in hello.txt:1' };
      return req.messages.at(-1)?.parts[0]?.type === 'tool_result'
        ? { text: 'subagent says: found it in hello.txt:1' }
        : {
            toolCalls: [
              {
                name: 'task',
                input: { agent: 'explore', description: 'find hello', prompt: 'find hello' },
              },
              {
                name: 'task',
                input: { agent: 'explore', description: 'find world', prompt: 'find world' },
              },
            ],
          };
    }, []);
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'where is hello?');
    expect(r.text).toContain('found it');
    const started = events.filter((e) => e.type === 'subagent.started');
    expect(started).toHaveLength(2);
    const childEvents = events.filter((e) => 'parentSessionId' in e && e.parentSessionId === s.id);
    expect(childEvents.length).toBeGreaterThan(0);
    expect(lp.requests.filter((q) => q.system.includes('read-only search agent'))).toHaveLength(2);
    // Explore is read-only: its tool list must not include write or task.
    const exploreReq = lp.requests.find((q) => q.system.includes('read-only search agent'));
    // The checklist, skills, and docs come with every agent; they aren't capabilities.
    expect(exploreReq?.tools.map((t) => t.name).sort()).toEqual([
      'docs',
      'glob',
      'grep',
      'read',
      'skill',
      'todo',
    ]);
  });

  test('the session receipt includes subagents and the reference model', async () => {
    const { engine } = setup((req) => {
      if (req.system.includes('read-only search agent')) return { text: 'found' };
      return req.messages.at(-1)?.parts[0]?.type === 'tool_result'
        ? { text: 'done' }
        : {
            toolCalls: [
              { name: 'task', input: { agent: 'explore', description: 'd', prompt: 'p' } },
            ],
          };
    }, []);
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'go');
    const other = engine.createSession({});
    await engine.runTurn(other.id, 'unrelated');
    const receipt = engine.usage(undefined, s.id);
    // Parent: two calls; explore subagent: one.
    expect(receipt.byModel?.[0]?.calls).toBe(3);
    expect(receipt.referenceModel).toBe('claude-opus-5');
    expect(receipt.estimatedSavingsUsd).toBeGreaterThan(0);
    expect(engine.getSession(s.id).session.savingsUsd).toBeGreaterThan(0);
  });

  test('asks for permission and honors the answer', async () => {
    const { engine, events } = setup(
      [
        { toolCalls: [{ name: 'write', input: { path: 'out.txt', content: 'x' } }] },
        { text: 'done' },
      ],
      [],
      { config: { permissions: { edit: 'ask' } } },
    );
    engine.subscribe((e) => {
      if (e.type === 'permission.requested') engine.respondPermission(e.requestId, 'allow_once');
    });
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'write it');
    expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('x');
    expect(events.some((e) => e.type === 'permission.requested')).toBe(true);
  });

  test('edit permission prompts carry a unified diff preview', async () => {
    const { engine, events } = setup(
      [
        {
          toolCalls: [
            { name: 'edit', input: { path: 'hello.txt', oldString: 'world', newString: 'there' } },
          ],
        },
        { text: 'done' },
      ],
      [],
      { config: { permissions: { edit: 'ask' } } },
    );
    engine.subscribe((e) => {
      if (e.type === 'permission.requested') engine.respondPermission(e.requestId, 'allow_once');
    });
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'edit it');
    const req = events.find((e) => e.type === 'permission.requested');
    expect(req && 'preview' in req && req.preview).toContain('-hello world\n+hello there');
    expect(req && 'proposed' in req && req.proposed).toEqual({
      path: 'hello.txt',
      content: 'hello there\n',
    });
    expect(events.find((e) => e.type === 'permission.resolved')).toMatchObject({
      decision: 'allow_once',
    });
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hello there\n');
  });

  test('an edit that would fail is reported to the model without asking the user', async () => {
    const { engine, events, lp } = setup(
      [
        {
          toolCalls: [
            { name: 'edit', input: { path: 'hello.txt', oldString: 'nope', newString: 'x' } },
          ],
        },
        { text: 'ok' },
      ],
      [],
      { config: { permissions: { edit: 'ask' } } },
    );
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'edit it');
    expect(events.some((e) => e.type === 'permission.requested')).toBe(false);
    const result = lp.requests[1]?.messages.at(-1)?.parts[0] as {
      content: string;
      isError: boolean;
    };
    expect(result).toMatchObject({ isError: true, content: 'oldString not found in file' });
  });

  test('the bash tool runs a real command in the workspace', async () => {
    const { engine, lp } = setup(
      [
        { toolCalls: [{ name: 'bash', input: { command: 'echo switchback-ok' } }] },
        { text: 'ran' },
      ],
      [],
      { config: { permissions: { bash: 'allow' } } },
    );
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'run it');
    const result = lp.requests[1]?.messages.at(-1)?.parts[0] as {
      content: string;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('switchback-ok');
    expect(result.content).toContain('exit code: 0');
  });

  test('denied tools return an error result to the model', async () => {
    const { engine, lp } = setup(
      [{ toolCalls: [{ name: 'bash', input: { command: 'echo hi' } }] }, { text: 'ok' }],
      [],
    );
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'run it');
    const result = lp.requests[1]?.messages.at(-1)?.parts[0];
    expect(result).toMatchObject({ type: 'tool_result', isError: true });
  });

  test('asks before editing outside the workspace, though edits are allowed', async () => {
    const { engine, lp, events } = setup(
      [
        { toolCalls: [{ name: 'write', input: { path: '../outside.txt', content: 'x' } }] },
        { text: 'ok' },
      ],
      [],
    );
    engine.subscribe((e) => {
      if (e.type === 'permission.requested') engine.respondPermission(e.requestId, 'deny');
    });
    await engine.runTurn(engine.createSession({}).id, 'write it');
    expect(events.find((e) => e.type === 'permission.requested')).toMatchObject({
      reason: 'outside the workspace',
    });
    expect(lp.requests[1]?.messages.at(-1)?.parts[0]).toMatchObject({ isError: true });
  });

  test('ask escalation policy waits for the user', async () => {
    const { engine, rp, events } = setup(
      [{ error: new ProviderError('bad output', 'lp', false) }, { text: 'local retry' }],
      [{ text: 'remote' }],
      { config: { routing: { escalation: { policy: 'ask' } } } },
    );
    engine.subscribe((e) => {
      if (e.type === 'escalation.requested') engine.respondEscalation(e.requestId, false);
    });
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'hi');
    expect(events.some((e) => e.type === 'escalation.requested')).toBe(true);
    expect(rp.requests).toHaveLength(0);
    expect(r.text).toBe('local retry');
  });
});

describe('what clients show', () => {
  test('an edit reports its diff to clients, never to the model', async () => {
    const { engine, lp, events } = setup(
      [
        {
          toolCalls: [
            { name: 'edit', input: { path: 'hello.txt', oldString: 'world', newString: 'there' } },
          ],
        },
        { text: 'done' },
      ],
      [],
    );
    await engine.runTurn(engine.createSession({}).id, 'edit it');
    const done = events.find((e) => e.type === 'tool.completed');
    expect(done).toMatchObject({ name: 'edit', isError: false });
    expect(done?.type === 'tool.completed' && done.diff).toContain('-hello world\n+hello there');
    const sent = JSON.stringify(lp.requests[1]?.messages.at(-1));
    expect(sent).not.toContain('+hello there');
  });

  test("routing says how big the chosen model's context is", async () => {
    const { engine, events } = setup([{ text: 'hi' }], []);
    await engine.runTurn(engine.createSession({}).id, 'hello');
    expect(events.find((e) => e.type === 'route.decided')).toMatchObject({ contextWindow: 8_000 });
  });
});

describe('escalation cost and routing analytics', () => {
  test('an escalation prompt carries a cost estimate and the ledger records the rule', async () => {
    const { engine, events } = setup(
      [{ error: new ProviderError('bad output', 'lp', false) }],
      [{ text: 'remote answer' }],
      { config: { routing: { escalation: { policy: 'ask' } } } },
    );
    engine.subscribe((e) => {
      if (e.type === 'escalation.requested') engine.respondEscalation(e.requestId, true);
    });
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'x'.repeat(4_000));
    expect(r.text).toBe('remote answer');
    const ask = events.find((e) => e.type === 'escalation.requested');
    // claude-opus-5 is $5/M input: ~1k+ prompt tokens, so a few tenths of a cent at least.
    expect(ask?.type === 'escalation.requested' && ask.estimatedCostUsd).toBeGreaterThan(0.005);
    const report = engine.usage('today');
    expect(report.byRule?.map((row) => row.key)).toEqual(['escalation']);
    expect(report.byAgent?.[0]).toMatchObject({ key: 'build', calls: 1 });
    expect(report.byModel?.[0]?.key).toBe('rp/claude-opus-5');
  });

  test('no estimate when the target model has no known price', async () => {
    const { engine, events } = setup(
      [{ error: new ProviderError('bad output', 'lp', false) }, { text: 'local' }],
      [],
      {
        config: {
          models: {
            local: { provider: 'lp', model: 'small', contextWindow: 8_000 },
            remote: { provider: 'rp', model: 'unpriced-model', contextWindow: 100_000 },
          },
          routing: { escalation: { policy: 'ask' } },
        },
      },
    );
    engine.subscribe((e) => {
      if (e.type === 'escalation.requested') engine.respondEscalation(e.requestId, false);
    });
    await engine.runTurn(engine.createSession({}).id, 'hi');
    const ask = events.find((e) => e.type === 'escalation.requested');
    expect(ask).toBeDefined();
    expect(ask && 'estimatedCostUsd' in ask).toBe(false);
  });
});

describe('several providers at once', () => {
  test('two local servers and two remote providers: a down local server falls to the other', async () => {
    const laptop = Object.assign(new ScriptedProvider('laptop', 'local', [{ text: 'laptop' }]), {
      health: async () => ({ ok: false, detail: 'connection refused' }),
    });
    const gpu = new ScriptedProvider('gpu', 'local', [{ text: 'from the gpu box' }]);
    const openai = new ScriptedProvider('openai', 'remote', []);
    const deepseek = new ScriptedProvider('deepseek', 'remote', []);
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: {
          laptop: { type: 'mock', tier: 'local' },
          gpu: { type: 'mock', tier: 'local' },
          openai: { type: 'mock', tier: 'remote' },
          deepseek: { type: 'mock', tier: 'remote' },
        },
        models: {
          small: { provider: 'laptop', model: 'qwen3:8b', contextWindow: 32_000 },
          big: { provider: 'gpu', model: 'qwen3-coder-30b', contextWindow: 128_000 },
          sol: { provider: 'openai', model: 'gpt-6-sol' },
          pro: { provider: 'deepseek', model: 'deepseek-v4-pro' },
        },
        routing: { start: ['small', 'big'], escalate: [['sol', 'pro']] },
      }),
      providers: new Map<string, Provider>([
        ['laptop', laptop],
        ['gpu', gpu],
        ['openai', openai],
        ['deepseek', deepseek],
      ]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const r = await engine.runTurn(engine.createSession({}).id, 'hi');
    expect(r.text).toBe('from the gpu box');
    expect(events.find((e) => e.type === 'route.decided')).toMatchObject({
      tier: 'local',
      rule: 'fallback',
      model: { provider: 'gpu' },
    });
    expect(engine.initialize().models.map((m) => m.alias)).toEqual(['small', 'big', 'sol', 'pro']);
  });
});

describe('refusal fallback', () => {
  test('a remote refusal retries on the next remote provider; the refusal is not kept', async () => {
    const anthropic = new ScriptedProvider('anthropic', 'remote', [
      { text: 'I can’t help with that', stopReason: 'refusal' },
    ]);
    const openai = new ScriptedProvider('openai', 'remote', [{ text: 'here you go' }]);
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: {
          anthropic: { type: 'mock', tier: 'remote' },
          openai: { type: 'mock', tier: 'remote' },
        },
        models: {
          opus: { provider: 'anthropic', model: 'claude-opus-5' },
          sol: { provider: 'openai', model: 'gpt-6-sol' },
        },
        routing: { start: ['opus', 'sol'] },
      }),
      providers: new Map<string, Provider>([
        ['anthropic', anthropic],
        ['openai', openai],
      ]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'hi');
    expect(r).toEqual({ stopReason: 'end_turn', text: 'here you go' });
    const routes = events.filter((e) => e.type === 'route.decided');
    expect(routes.map((e) => (e as { rule: string }).rule)).toEqual([
      'default',
      'refusal-fallback',
    ]);
    expect(engine.getSession(s.id).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // Both calls are billed.
    expect(
      engine
        .usage('today')
        .byRule?.map((row) => row.key)
        .sort(),
    ).toEqual(['default', 'refusal-fallback']);
  });

  test('with no other remote model the refusal ends the turn as a refusal', async () => {
    const { engine } = setup([], [{ text: 'no', stopReason: 'refusal' }], {
      config: { routing: { start: ['remote'], escalate: [] } },
    });
    const r = await engine.runTurn(engine.createSession({}).id, 'hi');
    expect(r.stopReason).toBe('refusal');
  });
});

describe('prompt caching', () => {
  test('consecutive requests share a byte-identical prefix', async () => {
    const { engine, rp } = setup(
      [],
      [
        { toolCalls: [{ name: 'read', input: { path: 'hello.txt' } }] },
        { text: 'it says hello' },
        { text: 'second answer' },
      ],
      { config: { routing: { start: ['remote'], escalate: [] } } },
    );
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'read hello.txt');
    await engine.runTurn(s.id, 'and again');
    expect(rp.requests).toHaveLength(3);
    const [first, ...rest] = rp.requests.map((r) => ({
      system: r.system,
      tools: JSON.stringify(r.tools),
      messages: JSON.stringify(r.messages),
      count: r.messages.length,
      raw: r.messages,
    }));
    for (const next of rest) {
      expect(next.system).toBe(first?.system ?? '');
      expect(next.tools).toBe(first?.tools ?? '');
    }
    // Each request's transcript starts with the previous request's, byte for byte.
    const all = [first, ...rest];
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur = all[i];
      if (!prev || !cur) throw new Error('missing request');
      expect(JSON.stringify(cur.raw.slice(0, prev.count))).toBe(prev.messages);
    }
  });

  test('warns once when a follow-up call to the same remote model misses the cache', async () => {
    const miss = { inputTokens: 20_000, outputTokens: 50, cacheReadTokens: 0 };
    const hit = { inputTokens: 500, outputTokens: 50, cacheReadTokens: 19_500 };
    const warnings = async (usages: (typeof miss)[]) => {
      const { engine, events } = setup(
        [],
        usages.map((usage, i) =>
          i < usages.length - 1
            ? { toolCalls: [{ name: 'read', input: { path: 'hello.txt', n: i } }], usage }
            : { text: 'done', usage },
        ),
        { config: { routing: { start: ['remote'], escalate: [] } } },
      );
      await engine.runTurn(engine.createSession({}).id, 'go');
      return events.filter(
        (e) => e.type === 'log' && e.level === 'warn' && /prompt-cache/.test(e.message),
      );
    };
    expect(await warnings([miss, hit, hit])).toHaveLength(0);
    expect(await warnings([miss, miss, miss])).toHaveLength(1);
    // Small prompts can legitimately miss (below the provider's cacheable minimum).
    expect(
      await warnings([
        { ...miss, inputTokens: 900 },
        { ...miss, inputTokens: 900 },
      ]),
    ).toHaveLength(0);
  });
});

describe('per-agent budgets', () => {
  function withBudget(localUp: boolean) {
    const reviewer = parseAgentFile(
      '---\nname: reviewer\ndescription: reviews\nmodel: remote\nbudgetUsd: 0.0001\n---\nReview.',
      'reviewer.md',
      'project',
    );
    const task = {
      name: 'task',
      input: { agent: 'reviewer', description: 'review', prompt: 'look' },
    };
    const script =
      (tier: 'local' | 'remote'): Script =>
      (req) => {
        const afterTool = req.messages.at(-1)?.parts.some((p) => p.type === 'tool_result');
        if (!req.system.startsWith('Review.'))
          return afterTool ? { text: 'parent done' } : { toolCalls: [task] };
        // The reviewer keeps working remotely (about a cent per call) and wraps up locally.
        return tier === 'remote'
          ? {
              toolCalls: [{ name: 'read', input: { path: 'hello.txt' } }],
              usage: { inputTokens: 2_000, outputTokens: 100 },
            }
          : { text: 'reviewed locally' };
      };
    const lp = new ScriptedProvider('lp', 'local', script('local'), localUp);
    const rp = new ScriptedProvider('rp', 'remote', script('remote'));
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow: 100_000 },
          remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
        },
        routing: { start: ['local'], escalate: [['remote']], fallback: 'none' },
      }),
      providers: new Map<string, Provider>([
        ['lp', lp],
        ['rp', rp],
      ]),
      agents: new Map([...loadAgents([]).agents, ['reviewer', reviewer]]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    return { engine, rp, events };
  }
  const childRemoteCalls = (rp: ScriptedProvider) =>
    rp.requests.filter((r) => r.system.startsWith('Review.')).length;

  test('an over-budget subagent continues on the local model', async () => {
    const { engine, rp, events } = withBudget(true);
    await engine.runTurn(engine.createSession({}).id, 'review it');
    expect(childRemoteCalls(rp)).toBe(1);
    expect(
      events.find((e) => e.type === 'route.decided' && e.rule === 'agent-budget'),
    ).toMatchObject({ tier: 'local' });
    expect(events.find((e) => e.type === 'subagent.completed')).toMatchObject({ ok: true });
  });

  test('with no local model it is stopped, and the parent is told why', async () => {
    const { engine, rp } = withBudget(false);
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'review it', 'remote');
    expect(childRemoteCalls(rp)).toBe(1);
    const result = engine
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result');
    expect(result).toMatchObject({ isError: true });
    expect(result?.type === 'tool_result' && result.content).toContain(
      'subagent "reviewer" spent $',
    );
    expect(r.text).toBe('parent done');
  });
});

describe('background subagents', () => {
  function setupBg(childDelayMs: number) {
    const isChild = (system: string) => system.startsWith('You are a read-only search agent');
    const lp = new ScriptedProvider('lp', 'local', (req) => {
      if (isChild(req.system)) return { text: 'found it in src/parse.ts' };
      const last = req.messages.at(-1);
      if (last?.parts.some((p) => p.type === 'text' && p.backgroundTask))
        return { text: 'got the report' };
      if (last?.parts.some((p) => p.type === 'tool_result')) return { text: 'working meanwhile' };
      return {
        toolCalls: [
          {
            name: 'task',
            input: {
              agent: 'explore',
              description: 'find parser',
              prompt: 'find it',
              background: true,
            },
          },
        ],
      };
    });
    const stream = lp.stream.bind(lp);
    lp.stream = async function* (req) {
      if (isChild(req.system)) await Bun.sleep(childDelayMs);
      yield* stream(req);
    };
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' } },
        models: { local: { provider: 'lp', model: 'small', contextWindow: 100_000 } },
        routing: { start: ['local'], allowRemote: false },
      }),
      providers: new Map<string, Provider>([['lp', lp]]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    return { engine, events };
  }
  const shape = (engine: Engine, id: string) =>
    engine
      .getSession(id)
      .messages.map((m) =>
        m.role === 'assistant'
          ? `a:${m.parts.map((p) => (p.type === 'text' ? p.text : p.type)).join('+')}`
          : `u:${m.parts.map((p) => (p.type === 'text' && p.backgroundTask ? 'report' : p.type)).join('+')}`,
      );

  test('headless: the parent keeps working, then gets the report append-only', async () => {
    const { engine, events } = setupBg(100);
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'go');
    expect(r.text).toBe('got the report');
    expect(shape(engine, s.id)).toEqual([
      'u:text',
      'a:tool_call',
      'u:tool_result',
      'a:working meanwhile',
      'u:report',
      'a:got the report',
    ]);
    const report = engine.getSession(s.id).messages[4]?.parts[0];
    expect(report?.type === 'text' && report.text).toContain('found it in src/parse.ts');
    expect(events.find((e) => e.type === 'subagent.started')).toMatchObject({ background: true });
  });

  test('interactive: the turn ends first; the report starts a follow-up turn', async () => {
    const { engine, events } = setupBg(150);
    const s = engine.createSession({});
    engine.prompt({ sessionId: s.id, text: 'go' });
    const turns = () => events.filter((e) => e.type === 'turn.completed' && e.sessionId === s.id);
    for (let i = 0; i < 100 && turns().length < 1; i++) await Bun.sleep(10);
    expect(shape(engine, s.id).at(-1)).toBe('a:working meanwhile');
    expect(engine.busy()).toBe(true); // background work keeps a daemon alive
    for (let i = 0; i < 100 && turns().length < 2; i++) await Bun.sleep(10);
    expect(shape(engine, s.id).slice(-2)).toEqual(['u:report', 'a:got the report']);
    expect(engine.busy()).toBe(false);
  });

  test('cancelling the session cancels background tasks and drops their reports', async () => {
    const { engine, events } = setupBg(200);
    const s = engine.createSession({});
    engine.prompt({ sessionId: s.id, text: 'go' });
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'turn.completed'); i++)
      await Bun.sleep(10);
    expect(engine.cancel(s.id)).toBe(true);
    await Bun.sleep(300);
    expect(shape(engine, s.id).includes('u:report')).toBe(false);
    expect(events.filter((e) => e.type === 'turn.started' && e.sessionId === s.id)).toHaveLength(1);
    expect(engine.busy()).toBe(false);
  });
});

describe('token counting', () => {
  function withCounter(contextWindow: number, exact: number) {
    const counted: string[] = [];
    const lp = Object.assign(new ScriptedProvider('lp', 'local', [{ text: 'local' }]), {
      countTokens: async (_model: string, text: string) => {
        counted.push(text);
        return exact;
      },
    });
    const rp = new ScriptedProvider('rp', 'remote', [{ text: 'remote' }]);
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow },
          remote: { provider: 'rp', model: 'big', contextWindow: 1_000_000 },
        },
        routing: { start: ['local'], escalate: [['remote']] },
      }),
      providers: new Map<string, Provider>([
        ['lp', lp],
        ['rp', rp],
      ]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    return { engine, counted, events };
  }
  const routeOf = (events: EngineEvent[]) =>
    events.find((e) => e.type === 'route.decided') as Extract<
      EngineEvent,
      { type: 'route.decided' }
    >;

  test('far from the threshold: tokenizer estimate only, no server call', async () => {
    const { engine, counted, events } = withCounter(1_000_000, 1);
    await engine.runTurn(engine.createSession({}).id, 'hi');
    expect(counted).toHaveLength(0);
    expect(routeOf(events)).toMatchObject({ tier: 'local' });
    expect(routeOf(events).inputTokens).toBeGreaterThan(100);
  });

  test('near the threshold: the local server’s exact count decides', async () => {
    const probe = withCounter(1_000_000, 1);
    await probe.engine.runTurn(probe.engine.createSession({}).id, 'hi');
    const estimate = routeOf(probe.events).inputTokens ?? 0;

    // Window whose threshold sits right at the estimate; the server says it's far bigger.
    const { engine, counted, events } = withCounter(Math.ceil(estimate / 0.85) + 50, 1_000_000);
    await engine.runTurn(engine.createSession({}).id, 'hi');
    expect(counted).toHaveLength(1);
    expect(counted[0]).toContain('hi');
    expect(routeOf(events)).toMatchObject({ tier: 'remote', rule: 'context-overflow' });
  });
});

describe('protocol round-trip', () => {
  test('client drives the engine over a transport', async () => {
    const { engine } = setup([{ text: 'over the wire' }], []);
    const [serverSide, clientSide] = createTransportPair();
    serve(engine, serverSide);
    const client = new SwitchbackClient(clientSide);
    const init = await client.initialize({ name: 'test', version: '0' }, root);
    expect(init.agents.map((a) => a.name)).toContain('explore');

    const session = await client.request('session.create', {});
    const done = new Promise<EngineEvent[]>((resolve) => {
      const seen: EngineEvent[] = [];
      client.on((e) => {
        seen.push(e);
        if (e.type === 'turn.completed') resolve(seen);
      });
    });
    await client.request('session.prompt', { sessionId: session.id, text: 'hi' });
    const events = await done;
    const text = events
      .filter((e) => e.type === 'text.delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('over the wire');
  });

  test('session.setMode and permissions.list round-trip', async () => {
    const { engine } = setup([], [], { config: { permissions: { deny: ['bash(rm:*)'] } } });
    const [serverSide, clientSide] = createTransportPair();
    serve(engine, serverSide);
    const client = new SwitchbackClient(clientSide);
    await client.initialize({ name: 'test', version: '0' }, root);
    const session = await client.request('session.create', { permissionMode: 'plan' });
    expect(session.permissionMode).toBe('plan');
    const changed = new Promise<EngineEvent>((resolve) =>
      client.on((e) => e.type === 'mode.changed' && resolve(e)),
    );
    await client.request('session.setMode', { sessionId: session.id, mode: 'acceptEdits' });
    expect(await changed).toMatchObject({ mode: 'acceptEdits', sessionId: session.id });
    const p = await client.request('permissions.list', { sessionId: session.id });
    expect(p.mode).toBe('acceptEdits');
    expect(p.rules).toEqual([{ rule: 'bash(rm:*)', behavior: 'deny', source: 'config' }]);
  });

  test('rejects calls before initialize', async () => {
    const { engine } = setup([], []);
    const [serverSide, clientSide] = createTransportPair();
    serve(engine, serverSide);
    const client = new SwitchbackClient(clientSide);
    await expect(client.request('session.list', {})).rejects.toThrow('initialize');
  });

  test('daemon.retire works before initialize, checks the token, and reports back', async () => {
    const { engine } = setup([], []);
    const retired: string[] = [];
    const connect = (options: Parameters<typeof serve>[3]) => {
      const [serverSide, clientSide] = createTransportPair();
      serve(engine, serverSide, undefined, options);
      return new SwitchbackClient(clientSide);
    };
    // A private engine is never a shared daemon.
    expect(await connect({}).request('daemon.retire', { token: 'x' })).toEqual({
      retired: false,
      reason: 'not a shared engine',
    });
    const shared = {
      token: 'secret',
      ownsEngine: false,
      retire: () => ({ retired: true }),
      onRetired: () => retired.push('retired'),
    };
    await expect(connect(shared).request('daemon.retire', { token: 'wrong' })).rejects.toThrow(
      'invalid daemon token',
    );
    expect(retired).toEqual([]);
    expect(await connect(shared).request('daemon.retire', { token: 'secret' })).toEqual({
      retired: true,
    });
    expect(retired).toEqual(['retired']);
  });
});

describe('session roles', () => {
  test('a session can change its roles; others keep the config', async () => {
    const { engine, rp, events } = setup(
      [{ text: 'local' }, { text: 'local again' }],
      [{ text: 'remote' }],
    );
    const a = engine.createSession({});
    const b = engine.createSession({});
    const roles = engine.setRoles({ sessionId: a.id, start: ['remote'] });
    expect(roles).toMatchObject({
      start: ['remote'],
      escalate: [['remote']],
      overridden: ['start'],
    });
    expect(events.find((e) => e.type === 'roles.updated')).toMatchObject({ sessionId: a.id });
    expect((await engine.runTurn(a.id, 'hi')).text).toBe('remote');
    expect((await engine.runTurn(b.id, 'hi')).text).toBe('local');
    expect(rp.requests).toHaveLength(1);
    // Reset follows the config again.
    expect(engine.setRoles({ sessionId: a.id, reset: true }).overridden).toEqual([]);
    expect((await engine.runTurn(a.id, 'again')).text).toBe('local again');
  });

  test('route events say where the session is on the ladder', async () => {
    const { engine, events } = setup([{ text: 'ok' }], []);
    await engine.runTurn(engine.createSession({}).id, 'hi');
    expect(events.find((e) => e.type === 'route.decided')).toMatchObject({ step: 0, steps: 1 });
  });

  test('unknown models are refused, and an organization can lock a role', () => {
    const { engine } = setup([], []);
    const s = engine.createSession({});
    expect(() => engine.setRoles({ sessionId: s.id, start: ['ghost'] })).toThrow(
      '"ghost" is not a configured model',
    );
    const org = setup([], [], {
      org: {
        id: 'acme',
        name: 'Acme',
        version: '1',
        notes: [],
        enforcedKeys: ['routing.escalate'],
        remoteDisabled: false,
        bypassDisabled: false,
        userPermissionsDisabled: false,
      },
    });
    const o = org.engine.createSession({});
    expect(() => org.engine.setRoles({ sessionId: o.id, escalate: [['local']] })).toThrow(
      "Acme's policy sets routing.escalate",
    );
    expect(org.engine.setRoles({ sessionId: o.id, start: ['remote'] }).start).toEqual(['remote']);
  });

  test('save writes the roles to the user config as the default', () => {
    const file = join(root, 'user-config.json');
    const { engine } = setup([], [], { userConfigFile: file });
    const s = engine.createSession({});
    const r = engine.setRoles({
      sessionId: s.id,
      escalate: [['remote']],
      review: { mode: 'auto', models: [['remote']] },
      save: true,
    });
    expect(r.savedTo).toBe(file);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.routing).toEqual({ start: ['local'], escalate: [['remote']] });
    expect(saved.review).toEqual({ mode: 'auto', models: [['remote']] });
  });

  test('over the protocol', async () => {
    const { engine } = setup([], []);
    const [serverSide, clientSide] = createTransportPair();
    serve(engine, serverSide);
    const client = new SwitchbackClient(clientSide);
    await client.initialize({ name: 'test', version: '0' }, root);
    const session = await client.request('session.create', {});
    expect(await client.request('session.roles', { sessionId: session.id })).toMatchObject({
      start: ['local'],
      overridden: [],
    });
    const changed = await client.request('session.setRoles', {
      sessionId: session.id,
      subagents: 'local',
    });
    expect(changed).toMatchObject({ subagents: 'local', overridden: ['subagents'] });
  });
});

describe('headless sessions', () => {
  test('instructions join the system prompt; a refused call is marked denied', async () => {
    const { engine, lp, events } = setup(
      [{ toolCalls: [{ name: 'bash', input: { command: 'echo hi' } }] }, { text: 'ok' }],
      [],
    );
    const s = engine.createSession({ instructions: 'Answer in one line.' });
    await engine.runTurn(s.id, 'go');
    expect(lp.requests[0]?.system).toContain(
      '# Instructions for this session\nAnswer in one line.',
    );
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ denied: true });
  });
});

test('session.checkpoints and session.rewind round-trip', async () => {
  const { engine } = setup(
    [
      { toolCalls: [{ name: 'write', input: { path: 'hello.txt', content: 'changed\n' } }] },
      { text: 'ok' },
    ],
    [],
  );
  const [serverSide, clientSide] = createTransportPair();
  serve(engine, serverSide);
  const client = new SwitchbackClient(clientSide);
  await client.initialize({ name: 'test', version: '0' }, root);
  const session = await client.request('session.create', {});
  const done = new Promise<void>((resolve) =>
    client.on((e) => e.type === 'turn.completed' && resolve()),
  );
  await client.request('session.prompt', { sessionId: session.id, text: 'change hello' });
  await done;
  const [checkpoint] = await client.request('session.checkpoints', { sessionId: session.id });
  expect(checkpoint).toMatchObject({ prompt: 'change hello', files: ['hello.txt'] });
  const r = await client.request('session.rewind', {
    sessionId: session.id,
    turnId: checkpoint?.turnId as string,
    restore: 'files',
  });
  expect(r).toEqual({ files: ['hello.txt'] });
  expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hello world\n');
});
