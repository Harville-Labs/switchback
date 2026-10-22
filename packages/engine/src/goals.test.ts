import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EngineEvent, type GoalInfo, textOf } from '@switchback/protocol';
import { type Script, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { EXCERPT_CHARS, goalExcerpt, MAX_ERROR_STREAK, nextGoalStep } from './goals.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-goal-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(script: Script, goal: object = {}) {
  const config = SwitchbackConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' } },
    models: { local: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
    routing: { current: ['local'] },
    permissions: { bash: 'ask' },
    retry: { attempts: 0 },
    goal,
  });
  const lp = new ScriptedProvider('lp', 'local', script);
  const engine = new Engine({ workspaceRoot: root, config, providers: new Map([['lp', lp]]) });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  /** Resolves on the first event that matches. */
  const when = (match: (e: EngineEvent) => boolean) =>
    new Promise<EngineEvent>((resolve) => {
      const off = engine.subscribe((e) => {
        if (!match(e)) return;
        off();
        resolve(e);
      });
    });
  const ended = () =>
    when((e) => e.type === 'goal.updated' && e.goal.status !== 'active').then(
      (e) => (e as { goal: GoalInfo }).goal,
    );
  const completed = () => events.filter((e) => e.type === 'turn.completed').length;
  return { engine, lp, events, when, ended, completed };
}

const say = (text: string) => ({ text });
const report = (status: 'done' | 'blocked', summary: string) => ({
  toolCalls: [{ name: 'goal', input: { status, summary } }],
});
const askFirst = { toolCalls: [{ name: 'bash', input: { command: 'echo hi' } }] };
const userText = (lp: ScriptedProvider, i: number) =>
  lp.requests[i]?.messages
    .filter((m) => m.role === 'user')
    .map(textOf)
    .join('\n') ?? '';

describe('goals', () => {
  test('keep starting turns until the model reports the goal done', async () => {
    const { engine, lp, ended, completed } = setup([
      say('started'),
      say('halfway'),
      report('done', 'all tests pass'),
      say('Done: all tests pass.'),
    ]);
    const s = engine.createSession({});
    const r = engine.setGoal(s.id, 'make the tests pass');
    expect(r.goal).toMatchObject({ status: 'active', turns: 1, maxTurns: 25 });
    expect(r.turnId).toBeDefined();
    const goal = await ended();
    await Bun.sleep(20);
    expect(goal).toMatchObject({ status: 'done', turns: 3, note: 'all tests pass' });
    expect(lp.requests).toHaveLength(4);
    expect(completed()).toBe(3);
    expect(userText(lp, 0)).toContain('You are working toward a goal');
    expect(userText(lp, 1)).toContain('This is turn 2 of at most 25');
    expect(engine.getSession(s.id).session.goal).toMatchObject({ status: 'done' });
  });

  test('stop when the model says it is blocked', async () => {
    const { engine, lp, ended } = setup([
      report('blocked', 'which database?'),
      say('I need a database.'),
    ]);
    const s = engine.createSession({});
    engine.setGoal(s.id, 'add persistence');
    expect(await ended()).toMatchObject({ status: 'blocked', turns: 1, note: 'which database?' });
    await Bun.sleep(20);
    expect(lp.requests).toHaveLength(2);
  });

  test('stop at the turn limit', async () => {
    const { engine, lp, ended } = setup(() => say('still going'), { maxTurns: 3 });
    const s = engine.createSession({});
    engine.setGoal(s.id, 'never finishes');
    expect(await ended()).toMatchObject({
      status: 'stopped',
      turns: 3,
      note: 'reached the limit of 3 turns',
    });
    await Bun.sleep(20);
    expect(lp.requests).toHaveLength(3);
  });

  test('stop after failing turns in a row', async () => {
    const { engine, ended, completed } = setup(() => ({ error: new Error('model crashed') }));
    const s = engine.createSession({});
    engine.setGoal(s.id, 'keeps failing');
    expect(await ended()).toMatchObject({
      status: 'stopped',
      note: `${MAX_ERROR_STREAK} turns in a row failed`,
    });
    expect(completed()).toBe(MAX_ERROR_STREAK);
  });

  test('stop when the user interrupts, and start nothing after', async () => {
    const { engine, lp, when, ended } = setup([askFirst, say('more')]);
    const s = engine.createSession({});
    engine.setGoal(s.id, 'run it');
    await when((e) => e.type === 'permission.requested');
    const goal = ended();
    engine.cancel(s.id);
    expect(await goal).toMatchObject({ status: 'stopped', note: 'interrupted' });
    await when((e) => e.type === 'turn.completed');
    await Bun.sleep(20);
    expect(lp.requests).toHaveLength(1);
  });

  test('pause on a permission prompt and go on once it is answered', async () => {
    const { engine, lp, when, ended } = setup([
      askFirst,
      say('ran it'),
      report('done', 'ok'),
      say('ok'),
    ]);
    const s = engine.createSession({});
    engine.setGoal(s.id, 'run it');
    const ask = (await when((e) => e.type === 'permission.requested')) as Extract<
      EngineEvent,
      { type: 'permission.requested' }
    >;
    await Bun.sleep(30);
    expect(lp.requests).toHaveLength(1);
    engine.respondPermission(ask.requestId, 'allow_once');
    expect(await ended()).toMatchObject({ status: 'done', turns: 2 });
  });

  test('/goal stop lets the running turn finish and starts no more', async () => {
    const { engine, lp, when, ended } = setup([askFirst, say('ran it'), say('more')]);
    const s = engine.createSession({});
    engine.setGoal(s.id, 'run it');
    const ask = (await when((e) => e.type === 'permission.requested')) as Extract<
      EngineEvent,
      { type: 'permission.requested' }
    >;
    const goal = ended();
    expect(engine.setGoal(s.id, null).goal).toMatchObject({ status: 'stopped' });
    expect(await goal).toMatchObject({ note: 'stopped by the user' });
    engine.respondPermission(ask.requestId, 'allow_once');
    const done = await when((e) => e.type === 'turn.completed');
    expect(done).toMatchObject({ stopReason: 'end_turn' });
    await Bun.sleep(20);
    expect(lp.requests).toHaveLength(2);
    expect(engine.setGoal(s.id, null)).toEqual({});
  });

  test('carry on after a prompt that interrupts a turn', async () => {
    const { engine, lp, when, ended } = setup([
      askFirst,
      say('changed course'),
      report('done', 'ok'),
      say('ok'),
    ]);
    const s = engine.createSession({});
    engine.setGoal(s.id, 'run it');
    await when((e) => e.type === 'permission.requested');
    engine.prompt({ sessionId: s.id, text: 'use ls instead', delivery: 'interrupt' });
    expect(await ended()).toMatchObject({ status: 'done' });
    expect(userText(lp, 1)).toContain('use ls instead');
  });

  test('the goal tool refuses when there is no goal', async () => {
    const { engine, lp, when } = setup([report('done', 'nothing'), say('ok')]);
    const s = engine.createSession({});
    engine.prompt({ sessionId: s.id, text: 'hi' });
    await when((e) => e.type === 'turn.completed');
    const result = lp.requests[1]?.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result');
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('no active goal');
  });
});

describe('nextGoalStep', () => {
  const goal = { startedMs: 0, limitMs: 60_000, errors: 0, turns: 1, maxTurns: 5 };

  test('continues after a finished turn and resets the failure streak', () => {
    expect(nextGoalStep({ ...goal, errors: 2 }, 'end_turn', 1000)).toEqual({
      step: { kind: 'continue' },
      errors: 0,
    });
  });

  test('stops at the time limit', () => {
    expect(nextGoalStep(goal, 'end_turn', 60_000).step).toEqual({
      kind: 'stop',
      note: 'reached the limit of 1 minute',
    });
  });

  test('waits, without counting, when the turn was cancelled', () => {
    expect(nextGoalStep({ ...goal, errors: 1 }, 'cancelled', 0)).toEqual({
      step: { kind: 'wait' },
      errors: 1,
    });
  });
});

test('a continuation repeats a short objective and shortens a long one', () => {
  expect(goalExcerpt('make the tests pass')).toBe('make the tests pass');
  const long = 'x'.repeat(4000);
  const excerpt = goalExcerpt(long);
  expect(excerpt.startsWith('x'.repeat(EXCERPT_CHARS))).toBe(true);
  expect(excerpt.length).toBeLessThan(EXCERPT_CHARS + 50);
  expect(excerpt).toContain('in full in your first prompt');
});
