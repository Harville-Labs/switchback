import { expect, test } from 'bun:test';
import type { Message, SessionSummary } from '@harness/protocol';
import { fromTranscript, reduce } from './view.ts';

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
