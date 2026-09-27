import { describe, expect, test } from 'bun:test';
import type { Message } from '@harness/protocol';
import { toAnthropicMessages } from './anthropic.ts';
import { OpenAICompatibleProvider, toWireMessages } from './openai-compatible.ts';
import { costUsd, priceFor } from './pricing.ts';
import type { ChatEvent } from './types.ts';

const HISTORY: Message[] = [
  { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'local thoughts', origin: { provider: 'ollama', model: 'qwen' } },
      {
        type: 'reasoning',
        text: 'claude thoughts',
        origin: { provider: 'anthropic', model: 'claude-opus-5' },
        opaque: { signature: 'sig' },
      },
      { type: 'text', text: 'reading' },
      { type: 'tool_call', id: 'call.1:x', name: 'read', input: { path: 'a' } },
    ],
  },
  {
    role: 'user',
    parts: [{ type: 'tool_result', callId: 'call.1:x', content: 'A', isError: false }],
  },
];

describe('anthropic translation', () => {
  test('replays reasoning only to the model that produced it', () => {
    const same = toAnthropicMessages('anthropic', 'claude-opus-5', HISTORY);
    const other = toAnthropicMessages('anthropic', 'claude-sonnet-5', HISTORY);
    const blocks = (m: typeof same, i: number) => (m[i]?.content ?? []) as { type: string }[];
    const kinds = (m: typeof same) => blocks(m, 1).map((b) => b.type);
    expect(kinds(same)).toEqual(['thinking', 'text', 'tool_use']);
    expect(kinds(other)).toEqual(['text', 'tool_use']);
  });

  test('sanitizes foreign tool ids consistently', () => {
    const out = toAnthropicMessages('anthropic', 'claude-opus-5', HISTORY);
    const use = ((out[1]?.content ?? []) as { type: string; id?: string }[]).find(
      (b) => b.type === 'tool_use',
    );
    const result = ((out[2]?.content ?? []) as { tool_use_id?: string }[])[0];
    expect(use?.id).toBe('call_1_x');
    expect(result?.tool_use_id).toBe('call_1_x');
  });
});

describe('openai-compatible', () => {
  test('never sends reasoning and maps tool results to tool messages', () => {
    const wire = toWireMessages('sys', HISTORY);
    expect(wire.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(JSON.stringify(wire)).not.toContain('thoughts');
  });

  test('parses streamed text, tool call fragments, and usage', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"pa' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
    ];
    const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
    const fetchStub = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'ollama',
      baseUrl: 'http://x/v1',
      tier: 'local',
      fetch: fetchStub,
    });
    const events: ChatEvent[] = [];
    for await (const e of p.stream({
      model: 'm',
      system: '',
      messages: [],
      tools: [],
      maxTokens: 10,
    }))
      events.push(e);
    const done = events.at(-1);
    expect(done).toEqual({
      type: 'done',
      parts: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_call', id: 'c1', name: 'read', input: { path: 'a' } },
      ],
      usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: 'tool_use',
    });
  });

  test('flags malformed tool arguments instead of throwing', async () => {
    const chunk = {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'c', function: { name: 'read', arguments: '{bad' } }],
          },
        },
      ],
    };
    const fetchStub = (async () =>
      new Response(`data: ${JSON.stringify(chunk)}\n\n`)) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'o',
      baseUrl: 'http://x/v1',
      tier: 'local',
      fetch: fetchStub,
    });
    let done: ChatEvent | undefined;
    for await (const e of p.stream({
      model: 'm',
      system: '',
      messages: [],
      tools: [],
      maxTokens: 10,
    }))
      done = e;
    expect(done?.type === 'done' && done.parts[0]).toMatchObject({
      input: { __malformed: '{bad' },
    });
  });
});

describe('pricing', () => {
  test('resolves Bedrock-prefixed model ids', () => {
    expect(priceFor('anthropic.claude-sonnet-5')).toEqual(priceFor('claude-sonnet-5'));
    expect(priceFor('us.anthropic.claude-sonnet-5')).toEqual(priceFor('claude-sonnet-5'));
  });

  test('computes cost including cache tokens', () => {
    const cost = costUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 },
      { input: 5, output: 25, cacheRead: 0.5 },
    );
    expect(cost).toBeCloseTo(30.5);
  });
});
