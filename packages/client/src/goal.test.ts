import { expect, test } from 'bun:test';
import type { GoalInfo } from '@switchback/protocol';
import { goalStatus, parseGoalCommand, sessionGoal } from './goal.ts';
import { initialView, reduce } from './view.ts';

const goal = (over: Partial<GoalInfo> = {}): GoalInfo => ({
  objective: 'make the tests pass',
  status: 'active',
  turns: 1,
  maxTurns: 25,
  startedAt: '2026-10-21T00:00:00.000Z',
  ...over,
});
const update = (g: GoalInfo) => ({ type: 'goal.updated' as const, sessionId: 's', goal: g });

test('/goal arguments: none shows, stop stops, anything else is the objective', () => {
  expect(parseGoalCommand([])).toEqual({ kind: 'show' });
  expect(parseGoalCommand(['stop'])).toEqual({ kind: 'stop' });
  expect(parseGoalCommand(['fix', 'the', 'build'])).toEqual({
    kind: 'set',
    objective: 'fix the build',
  });
});

test('goal updates keep the latest goal and note only its start and end', () => {
  let v = reduce(initialView('s'), update(goal()));
  v = reduce(v, update(goal({ turns: 2 })));
  v = reduce(v, update(goal({ turns: 2, status: 'done', note: 'green' })));
  expect(v.goal).toMatchObject({ status: 'done', turns: 2 });
  expect(v.items.map((i) => (i.kind === 'info' ? i.text.split('\n')[0] : i.kind))).toEqual([
    '◎ working toward the goal, for up to 25 turns: make the tests pass',
    '◎ goal done after 2 turns: green',
  ]);
});

test('the view wins over the session summary once it has a goal', () => {
  const old = goal({ status: 'stopped' });
  expect(sessionGoal(initialView('s'), { goal: old })).toBe(old);
  const now = goal({ turns: 4 });
  expect(sessionGoal({ goal: now }, { goal: old })).toBe(now);
  expect(goalStatus(undefined)).toContain('/goal <objective>');
  expect(goalStatus(now)).toContain('turn 4/25');
});
