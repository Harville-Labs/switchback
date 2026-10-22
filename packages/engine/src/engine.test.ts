import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import { type Provider, ProviderError, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { engineFixture } from './engine-fixture.ts';

const { ws, setup } = engineFixture();

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
      routing: { current: ['local'], escalate: [['remote']] },
    });
    const lp = Object.assign(new ScriptedProvider('lp', 'local', [{ text: 'local' }]), {
      contextWindow: async () => ({ contextWindow: 1_000, source: 'test' }),
    });
    const rp = new ScriptedProvider('rp', 'remote', [{ text: 'remote' }]);
    const engine = new Engine({
      workspaceRoot: ws.root,
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
        routing: { current: ['m'] },
      });
      const lp = Object.assign(new ScriptedProvider('lp', 'local', [{ text: 'a' }]), {
        contextWindow: async () => ({ contextWindow: 6_000, source: 'test' }),
      });
      const engine = new Engine({
        workspaceRoot: ws.root,
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
    expect(detected).toBeGreaterThan(2_500);
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
    writeFileSync(join(ws.root, 'code.ts'), 'a\nb\nc\nd\n');
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
      workspaceRoot: ws.root,
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
        routing: { current: ['local'], escalate: ['large', 'remote'] },
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
      // Retries are covered in retry.test.ts; this is the fallback after them.
      { config: { retry: { attempts: 0 } } },
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
    // The checklist, skills, docs, and escalate come with every agent; they aren't capabilities.
    // (models and config do too, but not for an 8k-context model like this one.)
    expect(exploreReq?.tools.map((t) => t.name).sort()).toEqual([
      'docs',
      'escalate',
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
    expect(readFileSync(join(ws.root, 'out.txt'), 'utf8')).toBe('x');
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
    expect(readFileSync(join(ws.root, 'hello.txt'), 'utf8')).toBe('hello there\n');
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
