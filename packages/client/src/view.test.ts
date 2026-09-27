import { describe, expect, test } from 'bun:test';
import type { Message, SessionSummary, UsageReport } from '@harness/protocol';
import { estimateLabel, formatUsage, fromTranscript, initialView, reduce } from './view.ts';

const session: SessionSummary = {
  id: 'ses_1',
  title: 't',
  agent: 'build',
  createdAt: '',
  updatedAt: '',
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0.25,
};

const local = { provider: 'ollama', model: 'coder' };
const remote = { provider: 'anthropic', model: 'claude-opus-5' };

test('fromTranscript rebuilds prompts, routes, text, and tool outcomes', () => {
  const messages: Message[] = [
    { role: 'user', parts: [{ type: 'text', text: 'fix it' }] },
    {
      role: 'assistant',
      meta: { model: local, tier: 'local', routeReason: 'local by default' },
      parts: [
        { type: 'reasoning', text: 'hmm', origin: local },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_call', id: 'c1', name: 'read', input: { path: 'a.ts' } },
        { type: 'tool_call', id: 'c2', name: 'bash', input: { command: 'bun test' } },
      ],
    },
    {
      role: 'user',
      parts: [
        { type: 'tool_result', callId: 'c1', content: '1 line' },
        { type: 'tool_result', callId: 'c2', content: 'fail', isError: true },
      ],
    },
    {
      role: 'assistant',
      meta: { model: remote, tier: 'remote', routeReason: '3 consecutive tool errors' },
      parts: [{ type: 'text', text: 'Fixed.' }],
    },
  ];
  const view = fromTranscript(session, messages);
  expect(view.items.map((i) => i.kind)).toEqual([
    'user',
    'route',
    'assistant',
    'tool',
    'tool',
    'route',
    'assistant',
  ]);
  expect(
    view.items.filter((i) => i.kind === 'tool').map((i) => i.kind === 'tool' && i.status),
  ).toEqual(['ok', 'error']);
  expect(view).toMatchObject({ running: false, costUsd: 0.25, lastTier: 'remote' });

  // Live events continue from the rebuilt state.
  const next = reduce(view, { type: 'turn.started', sessionId: 'ses_1', turnId: 't' });
  expect(next.running).toBe(true);
});

describe('usage and estimate formatting', () => {
  const report: UsageReport = {
    period: { from: '2026-09-21', to: '2026-09-27' },
    byTier: {
      local: { usage: { inputTokens: 5000, outputTokens: 700 }, costUsd: 0 },
      remote: {
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 3000 },
        costUsd: 0.42,
      },
    },
    estimatedSavingsUsd: 1.5,
    budget: { spentTodayUsd: 0.1, spentMonthUsd: 0.42, dailyUsd: 2 },
    byRule: [
      {
        key: 'escalation',
        calls: 3,
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 3000 },
        costUsd: 0.42,
        savingsUsd: 0,
      },
    ],
    remoteCacheHitRate: 0.75,
  };

  test('summary shows cache hits and an optional breakdown', () => {
    const text = formatUsage(report, 'rule');
    expect(text).toContain('cache hits 75%');
    expect(text).toContain('today $0.10 of $2.00');
    expect(text).toMatch(/By rule\n {2}escalation\s+3 calls\s+4,000 in\s+\$0\.42/);
    expect(formatUsage(report)).not.toContain('By ');
    expect(formatUsage({ ...report, byAgent: [] }, 'agent')).toContain('no model calls');
  });

  test('estimate labels', () => {
    expect(estimateLabel(undefined)).toBe('');
    expect(estimateLabel(0.004)).toBe('≈ <$0.01');
    expect(estimateLabel(0.0412)).toBe('≈ $0.04');
    expect(estimateLabel(1.5)).toBe('≈ $1.50');
  });

  test('escalation requests keep their estimate in the view', () => {
    const v = reduce(initialView('s'), {
      type: 'escalation.requested',
      sessionId: 's',
      requestId: 'r',
      reason: 'stuck',
      target: { provider: 'p', model: 'm' },
      estimatedCostUsd: 0.03,
    });
    expect(v.escalations[0]?.estimatedCostUsd).toBe(0.03);
  });
});
