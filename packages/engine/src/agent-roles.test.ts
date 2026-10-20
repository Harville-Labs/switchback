import { describe, expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import {
  type ChatRequest,
  type Script,
  ScriptedProvider,
  type ScriptedTurn,
} from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';

function setup(local: Script, remote: Script = [], overrides: object = {}) {
  const config = SwitchbackConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
    models: {
      local: { provider: 'lp', model: 'small', effort: 'medium' },
      remote: { provider: 'rp', model: 'big' },
    },
    routing: { current: ['local'], escalate: [['remote']] },
    permissions: { edit: 'allow', bash: 'deny' },
    ...overrides,
  });
  const lp = new ScriptedProvider('lp', 'local', local);
  const rp = new ScriptedProvider('rp', 'remote', remote);
  const engine = new Engine({
    workspaceRoot: '/tmp',
    config,
    providers: new Map([
      ['lp', lp],
      ['rp', rp],
    ]),
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, lp, rp, events };
}

const isChild = (req: ChatRequest) => req.system.includes('child agent');
const lastIsResult = (req: ChatRequest) => req.messages.at(-1)?.parts[0]?.type === 'tool_result';
const childAgent = {
  description: 'does one thing',
  prompt: 'You are a child agent.',
  mode: 'subagent',
};

/** A parent that delegates once with `input`, then answers with what came back. */
const delegating =
  (input: object) =>
  (req: ChatRequest): ScriptedTurn => {
    if (isChild(req)) return { text: 'child done' };
    if (!lastIsResult(req))
      return {
        toolCalls: [
          { name: 'task', input: { agent: 'child', description: 't', prompt: 'p', ...input } },
        ],
      };
    const r = req.messages.at(-1)?.parts[0];
    return { text: r?.type === 'tool_result' ? `parent: ${r.content}` : 'parent' };
  };

describe('session effort', () => {
  test("a session's effort overrides the model's until it is cleared", async () => {
    const { engine, lp } = setup([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    const s = engine.createSession({ effort: 'high' });
    expect(s.effort).toBe('high');
    await engine.runTurn(s.id, 'one');
    expect(engine.setEffort(s.id, 'max')).toEqual({ effort: 'max' });
    await engine.runTurn(s.id, 'two');
    expect(engine.setEffort(s.id, null)).toEqual({});
    await engine.runTurn(s.id, 'three');
    expect(lp.requests.map((r) => r.effort)).toEqual(['high', 'max', 'medium']);
  });

  test('changing it tells clients', () => {
    const { engine, events } = setup([]);
    const s = engine.createSession({});
    engine.setEffort(s.id, 'low');
    engine.setEffort(s.id, null);
    const changes = events.filter((e) => e.type === 'effort.changed');
    expect(changes.map((e) => (e.type === 'effort.changed' ? e.effort : 0))).toEqual([
      'low',
      undefined,
    ]);
  });

  test("an agent's effort applies to top-level sessions too", async () => {
    const { engine, lp } = setup([{ text: 'a' }], [], { agents: { build: { effort: 'xhigh' } } });
    await engine.runTurn(engine.createSession({}).id, 'go');
    expect(lp.requests[0]?.effort).toBe('xhigh');
  });
});

describe('config agents', () => {
  test('add agents, change built-ins, and disable them', () => {
    const { engine } = setup([], [], {
      agents: {
        child: childAgent,
        explore: { effort: 'high' },
        general: { disable: true },
      },
    });
    const agents = engine.listAgents();
    expect(agents.find((a) => a.name === 'child')).toMatchObject({
      mode: 'subagent',
      source: 'config',
    });
    expect(agents.find((a) => a.name === 'explore')).toMatchObject({
      effort: 'high',
      mode: 'subagent',
    });
    expect(agents.some((a) => a.name === 'general')).toBe(false);
  });

  test('a subagent-only agent cannot start a session', () => {
    const { engine } = setup([]);
    expect(() => engine.createSession({ agent: 'explore' })).toThrow(/is a subagent/);
  });
});

describe('delegation', () => {
  test("an agent's list limits which subagents its task tool offers", async () => {
    const { engine, lp } = setup([{ text: 'ok' }], [], {
      agents: { child: childAgent, build: { agents: ['child'] } },
    });
    await engine.runTurn(engine.createSession({}).id, 'go');
    const task = lp.requests[0]?.tools.find((t) => t.name === 'task');
    expect(task?.description).toContain('- child:');
    expect(task?.description).not.toContain('- explore:');
  });

  test('an empty list removes the task tool', async () => {
    const { engine, lp } = setup([{ text: 'ok' }], [], { agents: { build: { agents: [] } } });
    await engine.runTurn(engine.createSession({}).id, 'go');
    expect(lp.requests[0]?.tools.some((t) => t.name === 'task')).toBe(false);
  });

  test('a subagent stops at its own step limit', async () => {
    const looping = (req: ChatRequest) =>
      isChild(req)
        ? { toolCalls: [{ name: 'glob', input: { pattern: '*.nothing' } }] }
        : delegating({})(req);
    const { engine, lp } = setup(looping, [], {
      agents: { child: { ...childAgent, maxSteps: 2 } },
    });
    const r = await engine.runTurn(engine.createSession({}).id, 'go');
    expect(lp.requests.filter(isChild)).toHaveLength(2);
    expect(r.text).toContain('parent:');
  });
});

describe('per-task model and effort', () => {
  test('the parent picks the model and effort for one task', async () => {
    const { engine, lp, rp, events } = setup(
      delegating({ model: 'remote', effort: 'max' }),
      [{ text: 'child done remotely' }],
      { agents: { child: childAgent } },
    );
    const r = await engine.runTurn(engine.createSession({}).id, 'go');
    expect(r.text).toContain('child done remotely');
    expect(rp.requests[0]?.effort).toBe('max');
    expect(lp.requests.filter(isChild)).toHaveLength(0);
    expect(events.find((e) => e.type === 'subagent.started')).toMatchObject({
      model: 'remote',
      effort: 'max',
    });
  });

  test("subagents use subagents.effort over the model's when the parent sets none", async () => {
    const { engine, lp } = setup(delegating({}), [], {
      agents: { child: childAgent },
      subagents: { effort: 'low' },
    });
    await engine.runTurn(engine.createSession({}).id, 'go');
    expect(lp.requests.find(isChild)?.effort).toBe('low');
    expect(lp.requests.find((r) => !isChild(r))?.effort).toBe('medium');
  });

  test('a local-only agent refuses a remote model', async () => {
    const { engine, rp } = setup(delegating({ model: 'remote' }), [], {
      agents: { child: { ...childAgent, model: 'local' } },
    });
    const r = await engine.runTurn(engine.createSession({}).id, 'go');
    expect(r.text).toContain('stays local');
    expect(rp.requests).toHaveLength(0);
  });
});
