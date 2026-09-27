import { describe, expect, test } from 'bun:test';
import type { Message } from '@harness/protocol';
import { aliasModels, CATALOG } from './catalog.ts';
import { normalizeUsage, OpenAICompatibleProvider } from './openai-compatible.ts';
import { createProvider } from './registry.ts';
import type { ChatEvent, ChatRequest } from './types.ts';

/** Captures the request body and answers with a fixed SSE stream. */
function capture(chunks: unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchStub = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const sse = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
    return new Response(sse);
  }) as unknown as typeof fetch;
  return { bodies, fetchStub };
}

async function drain(p: OpenAICompatibleProvider, req: Partial<ChatRequest>) {
  const events: ChatEvent[] = [];
  for await (const e of p.stream({
    model: 'm',
    system: 's',
    messages: [],
    tools: [],
    maxTokens: 100,
    ...req,
  }))
    events.push(e);
  return events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
}

const history = (origin: { provider: string; model: string }): Message[] => [
  { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'thinking...', origin },
      { type: 'tool_call', id: 'c1', name: 'read', input: { path: 'a' } },
    ],
  },
  { role: 'user', parts: [{ type: 'tool_result', callId: 'c1', content: 'A' }] },
];

describe('openai flavor', () => {
  test('uses max_completion_tokens and passes reasoning effort through', async () => {
    const { bodies, fetchStub } = capture([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]);
    const p = new OpenAICompatibleProvider({
      id: 'openai',
      baseUrl: 'https://x/v1',
      tier: 'remote',
      flavor: 'openai',
      apiKey: 'k',
      fetch: fetchStub,
    });
    await drain(p, { effort: 'xhigh' });
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 100, reasoning_effort: 'xhigh' });
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  test('never replays reasoning, even its own', async () => {
    const { bodies, fetchStub } = capture([{ choices: [{ delta: { content: 'ok' } }] }]);
    const p = new OpenAICompatibleProvider({
      id: 'openai',
      baseUrl: 'https://x/v1',
      tier: 'remote',
      flavor: 'openai',
      apiKey: 'k',
      fetch: fetchStub,
    });
    await drain(p, { messages: history({ provider: 'openai', model: 'm' }) });
    expect(JSON.stringify(bodies[0])).not.toContain('reasoning_content');
  });
});

describe('deepseek flavor', () => {
  test('enables thinking with a mapped effort and replays only its own reasoning', async () => {
    const { bodies, fetchStub } = capture([
      { choices: [{ delta: { reasoning_content: 'plan' } }] },
      { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
    ]);
    const p = new OpenAICompatibleProvider({
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      tier: 'remote',
      flavor: 'deepseek',
      apiKey: 'k',
      fetch: fetchStub,
    });
    const done = await drain(p, {
      model: 'deepseek-flash',
      effort: 'medium',
      messages: history({ provider: 'deepseek', model: 'deepseek-flash' }),
    });
    expect(bodies[0]).toMatchObject({
      reasoning_effort: 'high',
      thinking: { type: 'enabled' },
      max_tokens: 100,
    });
    const assistant = (
      (bodies[0]?.messages ?? []) as { role: string; reasoning_content?: string }[]
    ).find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_content).toBe('thinking...');
    // Its own new reasoning is captured with its origin for the next turn.
    expect(done.parts[0]).toEqual({
      type: 'reasoning',
      text: 'plan',
      origin: { provider: 'deepseek', model: 'deepseek-flash' },
    });

    await drain(p, {
      model: 'deepseek-flash',
      messages: history({ provider: 'ollama', model: 'qwen' }),
    });
    expect(JSON.stringify(bodies[1])).not.toContain('reasoning_content');
  });
});

describe('usage normalization', () => {
  test('input tokens exclude cache hits on both APIs', () => {
    expect(
      normalizeUsage({
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800 },
      }),
    ).toEqual({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 });
    expect(
      normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900 }),
    ).toMatchObject({ inputTokens: 100, cacheReadTokens: 900 });
  });
});

describe('hosted providers', () => {
  test('report a missing API key instead of calling out', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const health = await createProvider('openai', {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      }).health();
      expect(health).toEqual({
        ok: false,
        detail: 'no API key (set OPENAI_API_KEY or providers.<id>.apiKey)',
      });
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  test('every catalog provider maps all three agent aliases', () => {
    for (const kind of Object.keys(CATALOG) as (keyof typeof CATALOG)[]) {
      const aliases = aliasModels(kind);
      expect(Object.keys(aliases).sort()).toEqual(['haiku', 'opus', 'sonnet']);
    }
    expect(aliasModels('deepseek').sonnet.id).toBe('deepseek-v4-pro'); // no medium: next larger
    expect(aliasModels('openai').haiku.id).toBe('gpt-6-luna');
  });
});
