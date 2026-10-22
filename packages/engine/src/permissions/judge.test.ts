import { describe, expect, test } from 'bun:test';
import type { Message } from '@switchback/protocol';
import { judgeRequest, lastAsk, parseReply } from './judge.ts';

describe('parseReply', () => {
  test('reads the JSON object out of prose around it', () => {
    expect(parseReply('Here you go: {"approve": true, "reason": "runs the tests"} done')).toEqual({
      approve: true,
      reason: 'runs the tests',
    });
  });

  test('gives nothing for a reply without a verdict', () => {
    expect(parseReply('yes')).toBeUndefined();
    expect(parseReply('{"approve": "yes", "reason": "ok"}')).toBeUndefined();
    expect(parseReply('{"approve": true}')).toBeUndefined();
    expect(parseReply('{not json}')).toBeUndefined();
  });
});

describe('lastAsk', () => {
  test("takes the user's latest words, skipping reminders and tool results", () => {
    const messages: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'Plan mode is on', reminder: true },
          { type: 'text', text: 'add a test' },
        ],
      },
      {
        role: 'user',
        parts: [{ type: 'tool_result', callId: 't1', content: 'output' }],
      },
    ];
    expect(lastAsk(messages)).toBe('add a test');
  });

  test('keeps the end of a long request', () => {
    const text = `${'a'.repeat(5_000)}END`;
    const ask = lastAsk([{ role: 'user', parts: [{ type: 'text', text }] }]);
    expect(ask.length).toBe(4_001);
    expect(ask.endsWith('END')).toBe(true);
  });
});

test('judgeRequest cuts long inputs', () => {
  const request = judgeRequest('write it', {
    tool: 'write',
    summary: 'write b.txt',
    input: { content: 'x'.repeat(10_000) },
  });
  expect(request).toContain('The agent wants to call write: write b.txt');
  expect(request).toContain('… (cut)');
  expect(request.length).toBeLessThan(6_200);
});
