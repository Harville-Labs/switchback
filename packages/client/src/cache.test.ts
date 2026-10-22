import { expect, test } from 'bun:test';
import type { EngineEvent, Tier, Usage } from '@switchback/protocol';
import { cacheLabel } from './usage.ts';
import { initialView, reduce, type ViewState } from './view.ts';

const call = (tier: Tier, usage?: Usage): EngineEvent => ({
  type: 'call.stats',
  sessionId: 's',
  turnId: 't',
  model: { provider: 'p', model: 'm' },
  tier,
  outputTokens: 20,
  ...(usage ? { usage } : {}),
});

const turn: EngineEvent = { type: 'turn.started', sessionId: 's', turnId: 't' };

function fold(events: EngineEvent[]): ViewState {
  return events.reduce(reduce, initialView('s'));
}

test('hit rate is cache reads over all input tokens, for the session and the latest turn', () => {
  const v = fold([
    turn,
    call('remote', { inputTokens: 1000, outputTokens: 20, cacheWriteTokens: 1000 }),
    call('remote', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1900 }),
    turn,
    call('remote', { inputTokens: 50, outputTokens: 20, cacheReadTokens: 1950 }),
  ]);
  expect(v.cache).toEqual({
    session: { readTokens: 3850, inputTokens: 6000 },
    turn: { readTokens: 1950, inputTokens: 2000 },
  });
  expect(cacheLabel(v.cache)).toBe('cache 64% · turn 98%');
});

test('local calls that report no caching do not dilute the rate', () => {
  const v = fold([
    turn,
    call('remote', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 }),
    call('local', { inputTokens: 5000, outputTokens: 20 }),
    call('local', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 100 }),
  ]);
  expect(v.cache?.session).toEqual({ readTokens: 1000, inputTokens: 1200 });
  expect(cacheLabel(v.cache)).toBe('cache 83%');
});

test('no label until a call counts, and none from events without usage', () => {
  expect(cacheLabel(fold([turn, call('remote')]).cache)).toBeUndefined();
  expect(
    cacheLabel(fold([turn, call('local', { inputTokens: 10, outputTokens: 1 })]).cache),
  ).toBeUndefined();
});

test('a new turn shows the session rate until its first call lands', () => {
  const v = fold([
    turn,
    call('remote', { inputTokens: 500, outputTokens: 20, cacheReadTokens: 500 }),
    turn,
  ]);
  expect(v.cache?.turn).toEqual({ readTokens: 0, inputTokens: 0 });
  expect(cacheLabel(v.cache)).toBe('cache 50%');
});
