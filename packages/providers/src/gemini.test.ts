import { describe, expect, test } from 'bun:test';
import { ThinkingLevel } from '@google/genai';
import type { Message } from '@harness/protocol';
import { GeminiProvider, thinkingConfig, toGeminiContents } from './gemini.ts';
import type { ChatEvent } from './types.ts';

const origin = { provider: 'gemini', model: 'gemini-3.8-flash' };
const rawTurn = [
  { text: 'planning', thought: true },
  { functionCall: { id: 'c1', name: 'read', args: { path: 'a' } }, thoughtSignature: 'SIG' },
];
const history: Message[] = [
  { role: 'user', parts: [{ type: 'text', text: 'fix it' }] },
  {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'planning', origin, opaque: { geminiParts: rawTurn } },
      { type: 'tool_call', id: 'c1', name: 'read', input: { path: 'a' } },
    ],
  },
  { role: 'user', parts: [{ type: 'tool_result', callId: 'c1', content: 'A' }] },
];

describe('Gemini translation', () => {
  test('the same model gets its turn back verbatim, signatures included', () => {
    const contents = toGeminiContents(history, origin);
    expect(contents[1]).toEqual({ role: 'model', parts: rawTurn });
    // Function responses carry the call's name, looked up from the call.
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'c1', name: 'read', response: { output: 'A' } } }],
    });
  });

  test('other models get the neutral translation, without Gemini internals', () => {
    const contents = toGeminiContents(history, { provider: 'gemini', model: 'gemini-2.5-flash' });
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { id: 'c1', name: 'read', args: { path: 'a' } } }],
    });
  });

  test('thinking: levels for Gemini 3, budgets for 2.x, off for effort none', () => {
    expect(thinkingConfig('gemini-3.8-flash', 'high')).toEqual({
      includeThoughts: true,
      thinkingLevel: ThinkingLevel.HIGH,
    });
    expect(thinkingConfig('gemini-2.5-flash', 'medium')).toEqual({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
    expect(thinkingConfig('gemini-2.5-flash', 'none')).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfig('gemini-3.8-flash', undefined)).toEqual({ includeThoughts: true });
  });
});

test('streams through the SDK and keeps raw parts for replay', async () => {
  const bodies: { url: string; body: Record<string, unknown> }[] = [];
  const chunks = [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }] } }] },
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { functionCall: { name: 'grep', args: { pattern: 'x' } }, thoughtSignature: 'S1' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 1000,
        cachedContentTokenCount: 600,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 30,
      },
    },
  ];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    bodies.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
  const p = new GeminiProvider({ id: 'gemini', apiKey: 'k', fetch: fetchStub });
  const out: ChatEvent[] = [];
  for await (const e of p.stream({
    model: 'gemini-3.8-flash',
    system: 'be brief',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'find x' }] }],
    tools: [{ name: 'grep', description: 'Search', inputSchema: { type: 'object' } }],
    maxTokens: 100,
    effort: 'medium',
  }))
    out.push(e);
  expect(out[0]).toEqual({ type: 'reasoning.delta', text: 'thinking…' });
  const done = out.at(-1) as Extract<ChatEvent, { type: 'done' }>;
  expect(done.stopReason).toBe('tool_use');
  expect(done.usage).toEqual({
    inputTokens: 400,
    outputTokens: 50,
    cacheReadTokens: 600,
    cacheWriteTokens: 0,
  });
  expect(done.parts[0]).toMatchObject({
    type: 'reasoning',
    opaque: { geminiParts: [{ thought: true }, { thoughtSignature: 'S1' }] },
  });
  expect(done.parts[1]).toMatchObject({ type: 'tool_call', name: 'grep', input: { pattern: 'x' } });
  expect(bodies[0]?.url).toContain('gemini-3.8-flash:streamGenerateContent');
  expect(JSON.stringify(bodies[0]?.body)).toContain('"thinkingLevel":"MEDIUM"');
  expect(JSON.stringify(bodies[0]?.body)).toContain('"parametersJsonSchema"');
});

test('safety stops are refusals; no key is reported by health', async () => {
  const fetchStub = (async () =>
    new Response(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] })}\r\n\r\n`,
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    )) as unknown as typeof fetch;
  const p = new GeminiProvider({ id: 'gemini', apiKey: 'k', fetch: fetchStub });
  let done: ChatEvent | undefined;
  for await (const e of p.stream({
    model: 'gemini-2.5-flash',
    system: '',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxTokens: 10,
  }))
    done = e;
  expect(done).toMatchObject({ type: 'done', stopReason: 'refusal' });
  expect((await new GeminiProvider({ id: 'g' }).health()).ok).toBe(false);
});
