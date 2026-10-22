import { expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import { formatSubagents, subagentDetail } from './subagent-format.ts';
import { reduce } from './view.ts';
import { initialView, type ViewState } from './view-state.ts';

test('a subagent row names the model and effort its parent chose', () => {
  const row = {
    kind: 'subagent',
    status: 'done',
    model: 'remote',
    effort: 'max',
    tier: 'remote',
    toolCalls: 3,
  } as unknown as Parameters<typeof subagentDetail>[0];
  expect(subagentDetail(row)).toBe('remote · effort max · remote · 3 tool calls');
});

test('a queued subagent waits in place, then shows the model the router picked', () => {
  const scoped = { sessionId: 'p' };
  const events: EngineEvent[] = [
    { type: 'subagent.started', ...scoped, childSessionId: 'a', agent: 'explore', task: 'find a' },
    { type: 'subagent.queued', ...scoped, childSessionId: 'b', agent: 'review', task: 'review b' },
  ];
  let v: ViewState = events.reduce(reduce, initialView('p'));
  expect(formatSubagents(v).split('\n')).toEqual([
    ' 1. ◌ explore: find a · 0 tool calls',
    ' 2. ◷ review: review b · waiting for a free slot',
  ]);
  v = reduce(v, {
    type: 'subagent.started',
    ...scoped,
    childSessionId: 'b',
    agent: 'review',
    task: 'review b',
  });
  v = reduce(v, {
    type: 'route.decided',
    sessionId: 'b',
    parentSessionId: 'p',
    turnId: 't',
    tier: 'local',
    model: { provider: 'lp', model: 'qwen-coder' },
    rule: 'default',
    reason: 'default',
  });
  // Started in place: the rows keep the order the parent asked for them in.
  expect(formatSubagents(v).split('\n')).toEqual([
    ' 1. ◌ explore: find a · 0 tool calls',
    ' 2. ◌ review: review b · qwen-coder · local · 0 tool calls',
  ]);
});
