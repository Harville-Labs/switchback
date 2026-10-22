import { describe, expect, test } from 'bun:test';
import type { EngineEvent, Message, SessionSummary } from '@switchback/protocol';
import {
  formatLadder,
  formatModels,
  formatRoles,
  formatTodos,
  reviewLines,
  speedLabel,
} from './format.ts';
import {
  childView,
  fromTranscript,
  initialView,
  nextFocus,
  reduce,
  type TodoItem,
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

describe('view rows for notices, reviews, and escalations', () => {
  test('privacy and redaction notices', () => {
    let v = reduce(initialView('s'), {
      type: 'tool.completed',
      sessionId: 's',
      turnId: 't',
      callId: 'c',
      name: 'read',
      output: 'x',
      isError: false,
      private: 'read secrets/a.env',
    });
    expect(v.private).toBe('read secrets/a.env');
    expect(v.items.at(-1)).toMatchObject({ kind: 'info', text: expect.stringContaining('🔒') });
    v = reduce(v, {
      type: 'secrets.redacted',
      sessionId: 's',
      kinds: ['GITHUB_TOKEN', 'GITHUB_TOKEN', 'SLACK_TOKEN'],
      model: { provider: 'p', model: 'm' },
    });
    expect(v.items.at(-1)).toMatchObject({
      text: 'Redacted 3 secrets (GITHUB_TOKEN ×2, SLACK_TOKEN) before sending to m; the model sees placeholders.',
    });
  });

  test('review rows', () => {
    const v = reduce(initialView('s'), {
      type: 'review.completed',
      sessionId: 's',
      turnId: 't',
      verdict: 'revise',
      summary: 'add still subtracts',
      issues: [{ file: 'math.ts', line: 1, severity: 'bug', comment: 'use a + b' }],
      model: { provider: 'p', model: 'claude-opus-5' },
      round: 1,
    });
    const item = v.items.at(-1);
    if (item?.kind !== 'review') throw new Error('expected a review row');
    expect(reviewLines(item)).toEqual([
      '↻ claude-opus-5 asked for changes: add still subtracts',
      '  ✗ math.ts:1 use a + b',
    ]);
    expect(
      reviewLines({
        ...item,
        verdict: 'skipped',
        summary: 'routing mode is local-only',
        issues: [],
      }),
    ).toEqual(['Review skipped: routing mode is local-only']);
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

  test('tab cycles from the session through each subagent, depth-first, and back', () => {
    expect(nextFocus(view, undefined)).toBe('c1');
    expect(nextFocus(view, 'c1')).toBe('g1');
    expect(nextFocus(view, 'g1')).toBeUndefined();
    expect(nextFocus(view, undefined, -1)).toBe('g1');
  });

  test('prompts from any depth surface at the top, labeled by agent', () => {
    expect(view.escalations).toEqual([{ requestId: 'e1', reason: 'general: stuck', target: ref }]);
    expect(childView(view, 'g1')?.escalations).toEqual([]);
  });
});

describe('roles and the ladder', () => {
  const models = [
    { alias: 'fast', ref: { provider: 'ollama', model: 'qwen3:8b' }, tier: 'local' as const },
    { alias: 'large', ref: { provider: 'gpu', model: 'qwen3-coder-480b' }, tier: 'local' as const },
    {
      alias: 'opus',
      ref: { provider: 'anthropic', model: 'claude-opus-5' },
      tier: 'remote' as const,
    },
  ];
  const roles = {
    current: ['fast'],
    escalate: [['large'], ['opus']],
    review: { mode: 'auto' as const, models: [] },
    overridden: ['escalate' as const],
  };

  test('route events carry ladder position into the view; roles.updated is kept', () => {
    let v = initialView('s');
    v = reduce(v, {
      type: 'route.decided',
      sessionId: 's',
      turnId: 't',
      tier: 'local',
      model: { provider: 'gpu', model: 'qwen3-coder-480b' },
      rule: 'sticky',
      reason: 'recently escalated',
      step: 1,
      steps: 2,
      stickyTurns: 1,
    });
    expect(v.ladder).toEqual({ step: 1, steps: 2, model: 'qwen3-coder-480b', stickyTurns: 1 });
    expect(formatLadder(v.ladder)).toBe('step 1/2 qwen3-coder-480b, 1 more');
    expect(formatLadder({ step: 0, steps: 2, model: 'x' })).toBe('');
    v = reduce(v, { type: 'roles.updated', sessionId: 's', roles });
    expect(v.roles).toEqual(roles);
  });

  test('roles and models read clearly, marking session changes', () => {
    expect(formatRoles(roles, models)).toBe(
      [
        'turns start on    fast (qwen3:8b, local)',
        'hard turns go to  1. large (qwen3-coder-480b, local), then 2. opus (claude-opus-5, remote)  (this session)',
        'edits reviewed    by the escalation ladder',
        'subagents use     normal routing',
      ].join('\n'),
    );
    expect(formatModels(models, roles)).toContain('opus   claude-opus-5 (remote)  · step 2');
  });
});

describe('the todo checklist', () => {
  const items: TodoItem[] = [
    { text: 'read the parser', status: 'done' },
    { text: 'fix the bug', status: 'in_progress' },
    { text: 'add a test', status: 'pending' },
  ];

  test('follows the latest todo call, live and from a transcript', () => {
    const started = (input: unknown, callId = 'c1'): EngineEvent => ({
      type: 'tool.started',
      sessionId: 's',
      turnId: 't',
      callId,
      name: 'todo',
      input,
    });
    let v = reduce(initialView('s'), started({ items }));
    expect(v.todos).toEqual(items);
    // A malformed call (the engine rejects it) leaves the list as it was.
    v = reduce(v, started({ items: [{ text: 'x', status: 'later' }] }, 'c2'));
    expect(v.todos).toEqual(items);

    const messages: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'a', name: 'todo', input: { items } }],
      },
    ];
    expect(fromTranscript(session, messages).todos).toEqual(items);
  });

  test('reads as a checklist', () => {
    expect(formatTodos(items)).toEqual(['☑ read the parser', '▶ fix the bug', '☐ add a test']);
  });
});

test('a call’s speed lands on its route row and the status', () => {
  let v = initialView('s');
  v = reduce(v, {
    type: 'route.decided',
    sessionId: 's',
    turnId: 't',
    tier: 'local',
    model: { provider: 'p', model: 'qwen' },
    rule: 'default',
    reason: 'start',
  });
  v = reduce(v, {
    type: 'call.stats',
    sessionId: 's',
    turnId: 't',
    model: { provider: 'p', model: 'qwen' },
    tier: 'local',
    outputTokens: 400,
    tokensPerSecond: 52.4,
  });
  expect(v.items.at(-1)).toMatchObject({ kind: 'route', tokensPerSecond: 52.4 });
  expect(v.speed).toEqual({ model: 'qwen', tokensPerSecond: 52.4 });
  expect(speedLabel(52.4)).toBe('52 tok/s');
  expect(speedLabel(1_840)).toBe('1.8k tok/s');
});

test('the view keeps what clients show: context fill, diffs, and refusals', () => {
  const s = { sessionId: 's' };
  const view = [
    { type: 'turn.started', ...s, turnId: 't' },
    {
      type: 'route.decided',
      ...s,
      turnId: 't',
      tier: 'local',
      model: { provider: 'p', model: 'm' },
      rule: 'default',
      reason: 'start',
      inputTokens: 2_000,
      contextWindow: 8_000,
    },
    { type: 'tool.started', ...s, turnId: 't', callId: 'c1', name: 'edit', input: {} },
    {
      type: 'tool.completed',
      ...s,
      turnId: 't',
      callId: 'c1',
      name: 'edit',
      output: 'edited x',
      isError: false,
      diff: '@@ -1 +1 @@\n-a\n+b',
    },
    { type: 'tool.started', ...s, turnId: 't', callId: 'c2', name: 'bash', input: {} },
    {
      type: 'tool.completed',
      ...s,
      turnId: 't',
      callId: 'c2',
      name: 'bash',
      output: 'denied',
      isError: true,
      denied: true,
    },
  ].reduce((v, e) => reduce(v, e as EngineEvent), initialView('s'));
  expect(view.context).toEqual({ tokens: 2_000, window: 8_000 });
  const tools = view.items.filter((i) => i.kind === 'tool');
  expect(tools[0]).toMatchObject({ diff: '@@ -1 +1 @@\n-a\n+b' });
  expect(tools[1]).toMatchObject({ denied: true });
});
