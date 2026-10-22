import { expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import { compactingLabel } from './format.ts';
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

test('compaction shows its progress until it ends, then a summary row', () => {
  const at = (phase: 'summarize' | 'merge' | 'end', done: number, total: number): EngineEvent => ({
    type: 'context.compacting',
    sessionId: 's',
    phase,
    done,
    total,
  });
  const merging = reduce(reduce(initialView('s'), at('summarize', 0, 4)), at('merge', 3, 4));
  expect(merging.compacting).toEqual({ phase: 'merge', done: 3, total: 4 });
  expect(compactingLabel(merging.compacting as { done: number; total: number })).toBe(
    'Compacting (3/4)',
  );
  expect(reduce(merging, at('end', 0, 0)).compacting).toBeUndefined();
});
