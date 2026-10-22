import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromTranscript } from '@switchback/client';
import type { Engine } from '../engine.ts';
import { edit, results, root, session, setup, useWorkspace } from './gate-fixture.ts';

useWorkspace();

const plan = { name: 'exit_plan_mode', input: { plan: '1. add b.txt' } };
const approve = (engine: Engine, decision: 'allow_once' | 'allow_always' | 'deny') =>
  engine.subscribe((e) => {
    if (e.type === 'permission.requested' && e.plan)
      engine.respondPermission(e.requestId, decision);
  });

describe('switching agents', () => {
  test('the plan agent refuses edits, and the model hears about the switch once', async () => {
    const { engine, lp, events } = setup([{ toolCalls: [edit] }, { text: 'ok' }, { text: 'ok' }], {
      edit: 'allow',
    });
    const id = session(engine);
    engine.setAgent(id, 'plan');
    expect(events.find((e) => e.type === 'agent.changed')).toMatchObject({ agent: 'plan' });
    await engine.runTurn(id, 'write it');
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
    expect(results(lp)[0]?.content).toContain("The plan agent can't use write");
    const reminders = (call: number) =>
      (lp.requests[call]?.messages ?? [])
        .flatMap((m) => m.parts)
        .filter(
          (p) => p.type === 'text' && p.reminder && /switched you to the plan agent/.test(p.text),
        );
    expect(reminders(0)).toHaveLength(1);
    await engine.runTurn(id, 'and now?');
    expect(reminders(2)).toHaveLength(1); // the first one, still in the transcript; no second
    // Every tool stays in the request, so the cache prefix doesn't move.
    expect(lp.requests[0]?.tools.map((t) => t.name)).toContain('write');
    // The reminder is for the model, not the transcript view.
    const { session: summary, messages } = engine.getSession(id);
    expect(summary.agent).toBe('plan');
    const view = fromTranscript(summary, messages);
    expect(view.items.filter((i) => i.kind === 'user').length).toBe(2);
  });

  test('approving a plan switches back to the agent before it', async () => {
    const { engine, lp, events } = setup(
      [{ toolCalls: [plan] }, { toolCalls: [edit] }, { text: 'done' }],
      { edit: 'allow' },
    );
    approve(engine, 'allow_once');
    const id = session(engine);
    engine.setAgent(id, 'plan');
    await engine.runTurn(id, 'plan then do it');
    expect(
      events
        .filter((e) => e.type === 'agent.changed')
        .map((e) => e.type === 'agent.changed' && e.agent),
    ).toEqual(['plan', 'build']);
    expect(results(lp)[0]?.content).toContain('approved');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('beta\n');
    expect(engine.getSession(id).session).toMatchObject({ agent: 'build', permissionLevel: 'ask' });
  });

  test('approve and auto-approve also sets the auto level; a session started in plan goes to the default agent', async () => {
    const { engine, events } = setup([{ toolCalls: [plan] }, { text: 'ok' }]);
    approve(engine, 'allow_always');
    const id = session(engine, undefined, 'plan');
    await engine.runTurn(id, 'plan it');
    expect(events.find((e) => e.type === 'permissions.changed')).toMatchObject({ level: 'auto' });
    expect(engine.getSession(id).session).toMatchObject({
      agent: 'build',
      permissionLevel: 'auto',
    });
  });

  test('keep planning stays with the plan agent; other agents have no plan to present', async () => {
    const { engine, lp } = setup([{ toolCalls: [plan] }, { toolCalls: [plan] }, { text: 'ok' }]);
    approve(engine, 'deny');
    const id = session(engine, undefined, 'plan');
    await engine.runTurn(id, 'plan it');
    expect(results(lp)[0]?.content).toContain('Keep planning');
    expect(results(lp, 2)[0]?.content).toContain('Keep planning');
    expect(engine.getSession(id).session.agent).toBe('plan');
    const build = setup([{ toolCalls: [plan] }, { text: 'ok' }]);
    await build.engine.runTurn(session(build.engine), 'plan it');
    expect(results(build.lp)[0]?.content).toContain("aren't working as a planning agent");
  });

  test('only agents that can lead a session can be switched to', () => {
    const { engine } = setup([]);
    const id = session(engine);
    expect(() => engine.setAgent(id, 'explore')).toThrow('only runs as a subagent');
    expect(() => engine.setAgent(id, 'nope')).toThrow('unknown agent "nope"');
  });
});

describe('agent permissions', () => {
  const custom = (permissions: object) => ({
    agents: {
      careful: { description: 'Careful.', prompt: 'Be careful.', mode: 'primary', permissions },
    },
  });

  test('an agent tightens a level the config allows', async () => {
    const { engine, events } = setup(
      [{ toolCalls: [edit] }, { text: 'ok' }],
      { edit: 'allow' },
      { interaction: 'deny' },
      custom({ edit: 'ask' }),
    );
    await engine.runTurn(session(engine, undefined, 'careful'), 'write it');
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
    expect(events.some((e) => e.type === 'permission.requested')).toBe(false); // headless deny
  });

  test("an agent can't loosen a level the config sets", async () => {
    const { engine, lp } = setup(
      [{ toolCalls: [edit] }, { text: 'ok' }],
      { edit: 'ask' },
      { interaction: 'deny' },
      custom({ edit: 'allow' }),
    );
    await engine.runTurn(session(engine, undefined, 'careful'), 'write it');
    expect(results(lp)[0]?.isError).toBe(true);
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
  });

  test("an agent's deny rule refuses, naming the agent; its ask rule beats a config allow", async () => {
    const push = { name: 'bash', input: { command: 'git push origin main' } };
    const rm = { name: 'bash', input: { command: 'rm -rf build' } };
    const { engine, lp } = setup(
      [{ toolCalls: [rm, push] }, { text: 'ok' }],
      { bash: 'allow', allow: ['bash(git push:*)'] },
      { interaction: 'deny' },
      custom({ deny: ['bash(rm:*)'], ask: ['bash(git push:*)'] }),
    );
    await engine.runTurn(session(engine, undefined, 'careful'), 'go');
    const [denied, asked] = results(lp);
    expect(denied?.content).toContain('bash(rm:*) (agent careful)');
    expect(asked?.isError).toBe(true);
  });

  test('read-only commands still run without asking in the plan agent', async () => {
    const ls = { name: 'bash', input: { command: 'ls && cat a.txt' } };
    const { engine, lp, events } = setup([{ toolCalls: [ls] }, { text: 'ok' }], { bash: 'allow' });
    await engine.runTurn(session(engine, undefined, 'plan'), 'look');
    expect(results(lp)[0]?.content).toContain('alpha');
    expect(events.some((e) => e.type === 'permission.requested')).toBe(false);
  });
});
