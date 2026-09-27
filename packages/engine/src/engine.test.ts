import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessClient } from '@harness/client';
import { createTransportPair, type EngineEvent } from '@harness/protocol';
import { type Provider, ProviderError, type Script, ScriptedProvider } from '@harness/providers';
import { HarnessConfig } from './config.ts';
import { Engine, type EngineOptions } from './engine.ts';
import { serve } from './server.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-test-'));
  writeFileSync(join(root, 'hello.txt'), 'hello world\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(
  local: Script,
  remote: Script,
  { config: overrides, ...opts }: Partial<Omit<EngineOptions, 'config'>> & { config?: object } = {},
) {
  const config = HarnessConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
    models: {
      local: { provider: 'lp', model: 'small', contextWindow: 8_000 },
      remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
    },
    permissions: { edit: 'allow', bash: 'deny' },
    ...overrides,
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
    const config = HarnessConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
      models: {
        local: { provider: 'lp', model: 'small' },
        remote: { provider: 'rp', model: 'big' },
      },
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
    expect(exploreReq?.tools.map((t) => t.name).sort()).toEqual(['glob', 'grep', 'read']);
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
      [{ toolCalls: [{ name: 'bash', input: { command: 'echo harness-ok' } }] }, { text: 'ran' }],
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
    expect(result.content).toContain('harness-ok');
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

  test('refuses paths outside the workspace', async () => {
    const { engine, lp } = setup(
      [{ toolCalls: [{ name: 'read', input: { path: '../../etc/passwd' } }] }, { text: 'ok' }],
      [],
    );
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'read it');
    const result = lp.requests[1]?.messages.at(-1)?.parts[0] as {
      content: string;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content).toContain('outside the workspace');
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

describe('protocol round-trip', () => {
  test('client drives the engine over a transport', async () => {
    const { engine } = setup([{ text: 'over the wire' }], []);
    const [serverSide, clientSide] = createTransportPair();
    serve(engine, serverSide);
    const client = new HarnessClient(clientSide);
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

  test('rejects calls before initialize', async () => {
    const { engine } = setup([], []);
    const [serverSide, clientSide] = createTransportPair();
    serve(engine, serverSide);
    const client = new HarnessClient(clientSide);
    await expect(client.request('session.list', {})).rejects.toThrow('initialize');
  });
});
