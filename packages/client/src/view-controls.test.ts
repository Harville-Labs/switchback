import { expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import { initialView, reduce } from './view.ts';

test('effort changes are kept, and clearing one is remembered as null', () => {
  const set = reduce(initialView('s'), { type: 'effort.changed', sessionId: 's', effort: 'high' });
  expect(set.effort).toBe('high');
  expect(reduce(set, { type: 'effort.changed', sessionId: 's' }).effort).toBeNull();
});

test('a subagent row keeps the model and effort its parent chose', () => {
  const started: EngineEvent = {
    type: 'subagent.started',
    sessionId: 's',
    childSessionId: 'c',
    agent: 'explore',
    task: 'find it',
    model: 'remote',
    effort: 'max',
  };
  const row = reduce(initialView('s'), started).items.find((i) => i.kind === 'subagent');
  expect(row).toMatchObject({ model: 'remote', effort: 'max' });
});

test('an auto-approved call shows who approved it and why; a refused one adds nothing', () => {
  const judged = {
    type: 'permission.judged',
    sessionId: 's',
    tool: 'bash',
    summary: 'bun test',
    reason: 'runs the tests',
    judge: 'local',
  } as const;
  const approved = reduce(initialView('s'), { ...judged, approved: true });
  expect(approved.items.at(-1)).toMatchObject({
    kind: 'info',
    text: 'auto-approved bun test (local): runs the tests',
  });
  expect(reduce(initialView('s'), { ...judged, approved: false }).items).toEqual([]);
});
