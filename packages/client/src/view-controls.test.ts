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
