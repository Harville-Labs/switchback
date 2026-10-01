import { describe, expect, test } from 'bun:test';
import type { Message } from '@switchback/protocol';
import { aliasModels, CATALOG } from './catalog.ts';
import {
  effortParams,
  flavorForUrl,
  normalizeUsage,
  OpenAICompatibleProvider,
} from './openai-compatible.ts';
import { createProvider } from './registry.ts';
import { type ChatEvent, type ChatRequest, ProviderError } from './types.ts';

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
        api: 'chat',
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

describe('openai SDK transport', () => {
  function recorder(status = 200) {
    const seen: { url: string; headers: Headers }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init.headers) });
      if (status !== 200) return new Response('{"error":{"message":"busy"}}', { status });
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
    }) as unknown as typeof fetch;
    return { seen, fetchStub };
  }

  test('never picks up OPENAI_* from the environment', async () => {
    const saved = { ...process.env };
    process.env.OPENAI_API_KEY = 'sk-should-not-leak';
    process.env.OPENAI_BASE_URL = 'https://wrong.example/v1';
    process.env.OPENAI_ORG_ID = 'org-leak';
    try {
      const { seen, fetchStub } = recorder();
      const p = new OpenAICompatibleProvider({
        id: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        tier: 'local',
        fetch: fetchStub,
      });
      await drain(p, {});
      expect(seen[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
      expect(seen[0]?.headers.get('authorization')).toBeNull();
      expect(seen[0]?.headers.get('openai-organization')).toBeNull();
    } finally {
      process.env = saved;
    }
  });

  test('sends the configured key and extra headers', async () => {
    const { seen, fetchStub } = recorder();
    const p = new OpenAICompatibleProvider({
      id: 'router',
      baseUrl: 'https://api.example/v1',
      tier: 'remote',
      apiKey: 'k1',
      headers: { 'x-title': 'switchback' },
      fetch: fetchStub,
    });
    await drain(p, {});
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer k1');
    expect(seen[0]?.headers.get('x-title')).toBe('switchback');
  });

  test('5xx from a local server is retryable and not retried by the SDK', async () => {
    const { seen, fetchStub } = recorder(503);
    const p = new OpenAICompatibleProvider({
      id: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      tier: 'local',
      fetch: fetchStub,
    });
    const err = await drain(p, {}).catch((e) => e);
    expect(err).toMatchObject({ name: 'ProviderError', retryable: true });
    expect(seen).toHaveLength(1);
  });

  test('400 is not retryable', async () => {
    const { fetchStub } = recorder(400);
    const p = new OpenAICompatibleProvider({
      id: 'x',
      baseUrl: 'http://localhost:1/v1',
      tier: 'local',
      fetch: fetchStub,
    });
    expect(await drain(p, {}).catch((e) => e)).toMatchObject({ retryable: false });
  });

  test('health reports HTTP status and unreachable servers', async () => {
    const down = new OpenAICompatibleProvider({
      id: 'x',
      baseUrl: 'http://127.0.0.1:9/v1',
      tier: 'local',
    });
    expect((await down.health()).ok).toBe(false);
    const { fetchStub } = recorder(401);
    const denied = new OpenAICompatibleProvider({
      id: 'x',
      baseUrl: 'http://localhost:1/v1',
      tier: 'local',
      fetch: fetchStub,
    });
    expect((await denied.health()).detail).toContain('HTTP 401');
  });
});

describe('local /tokenize', () => {
  function server(kind: 'llama.cpp' | 'vllm' | 'ollama') {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(url), body });
      if (kind === 'ollama') return new Response('404 page not found', { status: 404 });
      if (kind === 'llama.cpp') {
        if (!('content' in body)) return Response.json({ tokens: [] });
        return Response.json({ tokens: [1, 2, 3, 4, 5] });
      }
      if (!('prompt' in body)) return new Response('{"detail":"prompt required"}', { status: 422 });
      return Response.json({ count: 7, max_model_len: 32768, tokens: [] });
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: kind,
      baseUrl: 'http://gpu:8000/v1',
      tier: 'local',
      fetch: fetchStub,
    });
    return { p, calls };
  }

  test('llama.cpp: content shape, at the server root', async () => {
    const { p, calls } = server('llama.cpp');
    expect(await p.countTokens('m', 'hello world')).toBe(5);
    expect(calls[0]?.url).toBe('http://gpu:8000/tokenize');
  });

  test('vLLM: falls through to the prompt shape and remembers it', async () => {
    const { p, calls } = server('vllm');
    expect(await p.countTokens('m', 'hello')).toBe(7);
    expect(await p.countTokens('m', 'again')).toBe(7);
    expect(calls.map((c) => Object.keys(c.body)[0])).toEqual(['content', 'model', 'model']);
  });

  test('servers without /tokenize are asked once', async () => {
    const { p, calls } = server('ollama');
    expect(await p.countTokens('m', 'hello')).toBeUndefined();
    expect(await p.countTokens('m', 'hello')).toBeUndefined();
    expect(calls).toHaveLength(2); // both shapes, then never again
  });

  test('hosted APIs never get a tokenize call', async () => {
    const { fetchStub } = capture([]);
    const p = new OpenAICompatibleProvider({
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      tier: 'remote',
      apiKey: 'k',
      fetch: fetchStub,
    });
    expect(await p.countTokens('m', 'x')).toBeUndefined();
  });
});

describe('effort none (no thinking)', () => {
  test('each flavor turns thinking off its own way', () => {
    expect(effortParams('generic', 'none')).toEqual({
      reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(effortParams('openai', 'none')).toEqual({ reasoning_effort: 'none' });
    expect(effortParams('deepseek', 'none')).toEqual({});
    expect(effortParams('deepseek', 'high')).toMatchObject({ thinking: { type: 'enabled' } });
  });

  test('local servers get only the levels they accept', () => {
    expect(effortParams('generic', 'max')).toEqual({ reasoning_effort: 'high' });
    expect(effortParams('generic', 'low')).toEqual({ reasoning_effort: 'low' });
    expect(effortParams('openai', 'xhigh')).toEqual({ reasoning_effort: 'xhigh' });
  });
});

describe('openrouter flavor', () => {
  const openrouter = (fetchStub: typeof fetch) =>
    new OpenAICompatibleProvider({
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      tier: 'remote',
      flavor: 'openrouter',
      apiKey: 'k',
      fetch: fetchStub,
    });
  const claude = { provider: 'openrouter', model: 'anthropic/claude-opus-5' };

  test('is chosen from the base URL', () => {
    expect(flavorForUrl('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(flavorForUrl('https://eu.openrouter.ai/api/v1')).toBe('openrouter');
    expect(flavorForUrl('http://localhost:11434/v1')).toBe('generic');
    expect(flavorForUrl('https://notopenrouter.ai/v1')).toBe('generic');
  });

  test('sends effort as OpenRouter reasoning, not local-server fields', async () => {
    const { bodies, fetchStub } = capture([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]);
    await drain(openrouter(fetchStub), { effort: 'none' });
    expect(bodies[0]).toMatchObject({ reasoning: { effort: 'none' } });
    expect(bodies[0]).not.toHaveProperty('chat_template_kwargs');
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  });

  test('keeps streamed reasoning_details, merging fragments of one detail', async () => {
    const { fetchStub } = capture([
      {
        choices: [
          {
            delta: {
              reasoning: 'Let me ',
              reasoning_details: [
                {
                  type: 'reasoning.text',
                  text: 'Let me ',
                  format: 'anthropic-claude-v1',
                  index: 0,
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              reasoning: 'read it.',
              reasoning_details: [
                { type: 'reasoning.text', text: 'read it.', signature: 'sig-1', index: 0 },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              reasoning_details: [{ type: 'reasoning.encrypted', data: 'enc', index: 1 }],
              tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);
    const done = await drain(openrouter(fetchStub), { model: claude.model });
    expect(done.parts[0]).toEqual({
      type: 'reasoning',
      text: 'Let me read it.',
      origin: claude,
      opaque: {
        reasoningDetails: [
          {
            type: 'reasoning.text',
            text: 'Let me read it.',
            format: 'anthropic-claude-v1',
            signature: 'sig-1',
            index: 0,
          },
          { type: 'reasoning.encrypted', data: 'enc', index: 1 },
        ],
      },
    });
  });

  test('replays reasoning_details only to the model that produced them', async () => {
    const details = [{ type: 'reasoning.encrypted', data: 'enc', index: 0 }];
    const messages: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        parts: [
          {
            type: 'reasoning',
            text: 'mine',
            origin: claude,
            opaque: { reasoningDetails: details },
          },
          {
            type: 'reasoning',
            text: 'other',
            origin: { provider: 'openrouter', model: 'google/gemini-3-pro' },
            opaque: { reasoningDetails: [{ type: 'reasoning.encrypted', data: 'theirs' }] },
          },
          { type: 'tool_call', id: 'c1', name: 'read', input: {} },
        ],
      },
      { role: 'user', parts: [{ type: 'tool_result', callId: 'c1', content: 'A' }] },
    ];
    const { bodies, fetchStub } = capture([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]);
    await drain(openrouter(fetchStub), { model: claude.model, messages });
    const assistant = ((bodies[0]?.messages ?? []) as Record<string, unknown>[]).find(
      (m) => m.role === 'assistant',
    );
    expect(assistant?.reasoning_details).toEqual(details);
    // The text itself is never replayed, and another model's details never are.
    expect(JSON.stringify(bodies[0])).not.toContain('theirs');
    expect(assistant).not.toHaveProperty('reasoning_content');

    const other = capture([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
    await drain(openrouter(other.fetchStub), { model: 'openai/gpt-6-sol', messages });
    expect(JSON.stringify(other.bodies[0])).not.toContain('reasoning_details');
  });

  test('a mid-stream server error is retryable, so the router can fall back', async () => {
    const { fetchStub } = capture([
      { choices: [{ delta: { content: 'par' } }] },
      {
        error: { code: 'server_error', message: 'Provider disconnected unexpectedly' },
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
      },
    ]);
    const err = await drain(openrouter(fetchStub), {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).message).toContain('Provider disconnected unexpectedly');
  });

  test('a mid-stream client error is not retried', async () => {
    const { fetchStub } = capture([
      {
        error: { code: 400, message: 'bad request' },
        choices: [{ delta: {}, finish_reason: 'error' }],
      },
    ]);
    const err = await drain(openrouter(fetchStub), {}).catch((e: unknown) => e);
    expect((err as ProviderError).retryable).toBe(false);
  });

  test('finish_reason "error" without a payload is a retryable failure, not an empty answer', async () => {
    const { fetchStub } = capture([
      { choices: [{ delta: { content: '' }, finish_reason: 'error' }] },
    ]);
    const err = await drain(openrouter(fetchStub), {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });

  test('createProvider picks the flavor for an openrouter.ai base URL', async () => {
    const p = createProvider('openrouter', {
      type: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      tier: 'remote',
      apiKey: 'k',
    });
    expect((p as unknown as { flavor: string }).flavor).toBe('openrouter');
  });
});
