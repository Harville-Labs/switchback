import { describe, expect, test } from 'bun:test';
import type { EngineEvent, Message, SessionSummary, UsageReport } from '@harness/protocol';
import {
  childView,
  estimateLabel,
  formatUsage,
  fromTranscript,
  initialView,
  reduce,
} from './view.ts';

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

describe('subagent tree', () => {
  const ref = { provider: 'p', model: 'm' };
  const events: EngineEvent[] = [
    { type: 'turn.started', sessionId: 'root', turnId: 't' },
    {
      type: 'subagent.started',
      sessionId: 'root',
      childSessionId: 'c1',
      agent: 'explore',
      task: 'find the parser',
    },
    {
      type: 'route.decided',
      sessionId: 'c1',
      parentSessionId: 'root',
      turnId: 'c',
      tier: 'local',
      model: ref,
      rule: 'agent-pin',
      reason: 'explore runs local',
    },
    {
      type: 'tool.started',
      sessionId: 'c1',
      parentSessionId: 'root',
      turnId: 'c',
      callId: 'k1',
      name: 'grep',
      input: { pattern: 'parse' },
    },
    {
      type: 'tool.completed',
      sessionId: 'c1',
      parentSessionId: 'root',
      turnId: 'c',
      callId: 'k1',
      name: 'grep',
      output: 'src/parse.ts',
      isError: false,
    },
    // Depth 2: the explore agent delegates again.
    {
      type: 'subagent.started',
      sessionId: 'c1',
      parentSessionId: 'root',
      childSessionId: 'g1',
      agent: 'general',
      task: 'read it',
    },
    {
      type: 'tool.started',
      sessionId: 'g1',
      parentSessionId: 'c1',
      turnId: 'g',
      callId: 'k2',
      name: 'read',
      input: { path: 'src/parse.ts' },
    },
    {
      type: 'text.delta',
      sessionId: 'g1',
      parentSessionId: 'c1',
      turnId: 'g',
      text: 'it tokenizes',
    },
    {
      type: 'escalation.requested',
      sessionId: 'g1',
      parentSessionId: 'c1',
      requestId: 'e1',
      reason: 'stuck',
      target: ref,
    },
    {
      type: 'turn.completed',
      sessionId: 'g1',
      parentSessionId: 'c1',
      turnId: 'g',
      stopReason: 'end_turn',
    },
    {
      type: 'subagent.completed',
      sessionId: 'c1',
      parentSessionId: 'root',
      childSessionId: 'g1',
      agent: 'general',
      ok: true,
    },
    {
      type: 'text.delta',
      sessionId: 'c1',
      parentSessionId: 'root',
      turnId: 'c',
      text: 'The parser is in src/parse.ts.',
    },
    {
      type: 'turn.completed',
      sessionId: 'c1',
      parentSessionId: 'root',
      turnId: 'c',
      stopReason: 'end_turn',
    },
    {
      type: 'subagent.completed',
      sessionId: 'root',
      childSessionId: 'c1',
      agent: 'explore',
      ok: true,
    },
  ];
  const view = events.reduce(reduce, initialView('root'));

  test('the parent keeps a summary row', () => {
    expect(view.items.find((i) => i.kind === 'subagent')).toMatchObject({
      id: 'c1',
      status: 'ok',
      tier: 'local',
      toolCalls: 1,
      activity: 'grep',
    });
  });

  test('drilling down shows the child’s routes, tools, and final report', () => {
    const child = childView(view, 'c1');
    expect(child?.items.map((i) => i.kind)).toEqual([
      'user',
      'route',
      'tool',
      'subagent',
      'assistant',
    ]);
    expect(child?.items.at(-1)).toMatchObject({ text: 'The parser is in src/parse.ts.' });
    expect(child?.running).toBe(false);
  });

  test('depth 2 nests under its own parent', () => {
    expect(Object.keys(view.children)).toEqual(['c1']);
    const grandchild = childView(view, 'g1');
    expect(grandchild?.items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(childView(view, 'c1')?.items.find((i) => i.kind === 'subagent')).toMatchObject({
      id: 'g1',
      status: 'ok',
      toolCalls: 1,
    });
  });

  test('prompts from any depth surface at the top, labeled by agent', () => {
    expect(view.escalations).toEqual([{ requestId: 'e1', reason: 'general: stuck', target: ref }]);
    expect(childView(view, 'g1')?.escalations).toEqual([]);
  });
});
