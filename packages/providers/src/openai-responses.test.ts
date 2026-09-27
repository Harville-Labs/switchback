import { describe, expect, test } from 'bun:test';
import type { Message } from '@harness/protocol';
import type { Response } from 'openai/resources/responses/responses';
import { fromResponse, OpenAIResponsesProvider, toResponsesInput } from './openai-responses.ts';
import { createProvider } from './registry.ts';
import type { ChatEvent } from './types.ts';

const origin = { provider: 'openai', model: 'gpt-6-sol' };
const reasoning = {
  type: 'reasoning' as const,
  text: 'thought',
  origin,
  opaque: {
    responsesItem: { id: 'rs_1', encrypted_content: 'ENC', summary: [{ text: 'thought' }] },
  },
};
const history: Message[] = [
  { role: 'user', parts: [{ type: 'text', text: 'fix it' }] },
  {
    role: 'assistant',
    parts: [reasoning, { type: 'tool_call', id: 'call_1', name: 'read', input: { path: 'a' } }],
  },
  { role: 'user', parts: [{ type: 'tool_result', callId: 'call_1', content: 'A', isError: true }] },
];

describe('Responses API translation', () => {
  test('replays encrypted reasoning only to the model that produced it', () => {
    const same = toResponsesInput(history, origin);
    expect(same).toEqual([
      { role: 'user', content: 'fix it' },
      {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'ENC',
        summary: [{ type: 'summary_text', text: 'thought' }],
      },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'Error: A' },
    ]);
    const other = toResponsesInput(history, { provider: 'openai', model: 'gpt-6-luna' });
    expect(other.some((i) => 'type' in i && i.type === 'reasoning')).toBe(false);
  });

  test('maps output items, stop reasons, and cached usage', () => {
    const response = {
      output: [
        {
          type: 'reasoning',
          id: 'rs_2',
          encrypted_content: 'E2',
          summary: [{ type: 'summary_text', text: 'plan' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'reading', annotations: [] }],
        },
        { type: 'function_call', call_id: 'c9', name: 'grep', arguments: '{"pattern":"x"}' },
      ],
      incomplete_details: null,
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 20 },
        total_tokens: 1050,
      },
    } as unknown as Response;
    const r = fromResponse(response, origin);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
    expect(r.parts.map((p) => p.type)).toEqual(['reasoning', 'text', 'tool_call']);

    const refusal = fromResponse(
      {
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
        incomplete_details: null,
      } as unknown as Response,
      origin,
    );
    expect(refusal.stopReason).toBe('refusal');
    const cut = fromResponse(
      { output: [], incomplete_details: { reason: 'max_output_tokens' } } as unknown as Response,
      origin,
    );
    expect(cut.stopReason).toBe('max_tokens');
  });
});

test('streams through the SDK: deltas, then the canonical result', async () => {
  const bodies: Record<string, unknown>[] = [];
  const completed = {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello', annotations: [] }],
      },
    ],
    incomplete_details: null,
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12,
    },
  };
  const events = [
    {
      type: 'response.reasoning_summary_text.delta',
      delta: 'hmm',
      item_id: 'rs',
      output_index: 0,
      summary_index: 0,
      sequence_number: 1,
    },
    {
      type: 'response.output_text.delta',
      delta: 'hel',
      item_id: 'm',
      output_index: 1,
      content_index: 0,
      sequence_number: 2,
    },
    {
      type: 'response.output_text.delta',
      delta: 'lo',
      item_id: 'm',
      output_index: 1,
      content_index: 0,
      sequence_number: 3,
    },
    { type: 'response.completed', response: completed, sequence_number: 4 },
  ];
  const fetchStub = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  }) as unknown as typeof fetch;
  const p = new OpenAIResponsesProvider({
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'k',
    fetch: fetchStub,
  });
  const out: ChatEvent[] = [];
  for await (const e of p.stream({
    model: 'gpt-6-sol',
    system: 'be brief',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
    maxTokens: 100,
    effort: 'high',
  }))
    out.push(e);
  expect(out.map((e) => e.type)).toEqual(['reasoning.delta', 'text.delta', 'text.delta', 'done']);
  expect(out.at(-1)).toMatchObject({
    type: 'done',
    stopReason: 'end_turn',
    parts: [{ type: 'text', text: 'hello' }],
  });
  expect(bodies[0]).toMatchObject({
    model: 'gpt-6-sol',
    instructions: 'be brief',
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: 100,
    reasoning: { effort: 'high', summary: 'auto' },
    tools: [{ type: 'function', name: 'read', strict: false }],
  });
});

test('config selects the Responses API per provider', () => {
  const p = createProvider('openai', {
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    api: 'responses',
    apiKey: 'k',
  });
  expect(p).toBeInstanceOf(OpenAIResponsesProvider);
});
