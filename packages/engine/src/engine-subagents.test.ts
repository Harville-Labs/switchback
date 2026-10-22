import { describe, expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import { type Provider, type Script, ScriptedProvider } from '@switchback/providers';
import { loadAgents, parseAgentFile } from './agents.ts';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { engineFixture } from './engine-fixture.ts';

const { ws } = engineFixture();

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
      workspaceRoot: ws.root,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow: 100_000 },
          remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
        },
        routing: { current: ['local'], escalate: [['remote']], fallback: 'none' },
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
      workspaceRoot: ws.root,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' } },
        models: { local: { provider: 'lp', model: 'small', contextWindow: 100_000 } },
        routing: { current: ['local'], allowRemote: false },
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
      workspaceRoot: ws.root,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow },
          remote: { provider: 'rp', model: 'big', contextWindow: 1_000_000 },
        },
        routing: { current: ['local'], escalate: [['remote']] },
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
