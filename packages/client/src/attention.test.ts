import { expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import { AttentionTracker } from './attention.ts';

const started = (turnId: string, parentSessionId?: string): EngineEvent => ({
  type: 'turn.started',
  sessionId: 's',
  turnId,
  ...(parentSessionId ? { parentSessionId } : {}),
});
const completed = (
  turnId: string,
  stopReason: 'end_turn' | 'error' | 'cancelled',
): EngineEvent => ({
  type: 'turn.completed',
  sessionId: 's',
  turnId,
  stopReason,
});

test('asks for attention when an answer is needed', () => {
  const t = new AttentionTracker();
  const ask = (plan?: string) =>
    t.observe({
      type: 'permission.requested',
      sessionId: 's',
      requestId: 'r',
      tool: 'bash',
      summary: 'run `rm -rf build`',
      input: {},
      ...(plan ? { plan } : {}),
    });
  expect(ask()).toEqual({
    kind: 'waiting',
    message: 'Switchback needs your permission: run `rm -rf build`',
  });
  expect(ask('# Plan')?.message).toBe('Switchback has a plan for you to review');
  expect(
    t.observe({
      type: 'escalation.requested',
      sessionId: 's',
      requestId: 'e',
      reason: 'stuck',
      target: { provider: 'p', model: 'claude-sonnet-5' },
    })?.message,
  ).toBe('Switchback asks to escalate to claude-sonnet-5');
});

test('long top-level turns notify when they end; short, cancelled, and subagent turns do not', () => {
  let now = 0;
  const t = new AttentionTracker({ mode: 'system', afterSeconds: 30 }, () => now);
  t.observe(started('long'));
  t.observe(started('short'));
  t.observe(started('child', 'parent'));
  t.observe(started('stopped'));
  now = 10_000;
  expect(t.observe(completed('short', 'end_turn'))).toBeUndefined();
  now = 95_000;
  expect(t.observe(completed('long', 'end_turn'))).toEqual({
    kind: 'done',
    message: 'Switchback finished (1m 35s)',
  });
  expect(t.observe(completed('child', 'end_turn'))).toBeUndefined();
  expect(t.observe(completed('stopped', 'cancelled'))).toBeUndefined();
  t.observe(started('failed'));
  now = 200_000;
  expect(t.observe(completed('failed', 'error'))?.message).toBe(
    'Switchback stopped with an error (1m 45s)',
  );
});

test('off is silent, and afterSeconds 0 only asks', () => {
  const off = new AttentionTracker({ mode: 'off', afterSeconds: 30 });
  expect(
    off.observe({
      type: 'escalation.requested',
      sessionId: 's',
      requestId: 'e',
      reason: '',
      target: { provider: 'p', model: 'm' },
    }),
  ).toBeUndefined();
  let now = 0;
  const asksOnly = new AttentionTracker({ mode: 'bell', afterSeconds: 0 }, () => now);
  asksOnly.observe(started('t'));
  now = 1_000_000;
  expect(asksOnly.observe(completed('t', 'end_turn'))).toBeUndefined();
});
