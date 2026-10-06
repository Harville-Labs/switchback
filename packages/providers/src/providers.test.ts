import { describe, expect, test } from 'bun:test';
import type { Message } from '@switchback/protocol';
import { toAnthropicMessages } from './anthropic.ts';
import { parseModelList } from './model-list.ts';
import { OpenAICompatibleProvider, toWireMessages } from './openai-compatible.ts';
import { costUsd, priceFor } from './pricing.ts';
import { azureOpenAIBaseUrl, createProvider, ProviderConfig } from './registry.ts';
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

  test('asks a keyed server for its models and context window with the key', async () => {
    // llama.cpp with --api-key refuses even /props and /v1/models without it.
    const keyed = (async (input: string | URL | Request, init?: RequestInit) => {
      const auth =
        input instanceof Request
          ? input.headers.get('authorization')
          : new Headers(init?.headers).get('authorization');
      if (auth !== 'Bearer sk-test')
        return Response.json({ error: 'Invalid API Key' }, { status: 401 });
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/v1/models'))
        return Response.json({ data: [{ id: 'm', object: 'model' }] });
      if (url.endsWith('/props'))
        return Response.json({ default_generation_settings: { n_ctx: 8192 } });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'gpu',
      baseUrl: 'http://gpu:8080/v1',
      tier: 'local',
      apiKey: 'sk-test',
      fetch: keyed,
    });
    expect(await p.contextWindow('m')).toEqual({
      contextWindow: 8192,
      source: 'llama.cpp /props n_ctx',
    });
    expect((await p.health()).models).toEqual(['m']);
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

describe('model listings', () => {
  test("reads each vendor's context field, OpenRouter prices, and tool support", () => {
    const models = parseModelList({
      data: [
        { id: 'vllm-model', max_model_len: 32768 },
        {
          id: 'qwen/qwen3-coder',
          context_length: 262144,
          top_provider: { max_completion_tokens: 65536 },
          pricing: { prompt: '0.0000004', completion: '0.0000016', input_cache_read: '0.00000004' },
          supported_parameters: ['tools', 'temperature'],
        },
        { id: 'llama-3.3-70b-versatile', context_window: 131072 },
        { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'embed', supported_parameters: ['temperature'] },
        { object: 'model' },
      ],
    });
    expect(models).toEqual([
      { id: 'vllm-model', contextWindow: 32768, contextSource: '/models max_model_len' },
      {
        id: 'qwen/qwen3-coder',
        contextWindow: 262144,
        contextSource: '/models context_length',
        maxOutputTokens: 65536,
        price: { input: 0.4, output: 1.6, cacheRead: 0.04 },
        tools: true,
      },
      {
        id: 'llama-3.3-70b-versatile',
        contextWindow: 131072,
        contextSource: '/models context_window',
      },
      { id: 'openrouter/auto' },
      { id: 'embed', tools: false },
    ]);
    expect(parseModelList({ error: 'nope' })).toEqual([]);
  });

  test("a hosted OpenAI-compatible API's context window comes from its listing", async () => {
    const listing = (async (input: string | URL | Request) => {
      expect(String(input instanceof Request ? input.url : input)).toBe(
        'https://openrouter.ai/api/v1/models',
      );
      return Response.json({ data: [{ id: 'qwen/qwen3-coder', context_length: 262144 }] });
    }) as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      tier: 'remote',
      apiKey: 'k',
      fetch: listing,
    });
    expect(await p.contextWindow('qwen/qwen3-coder')).toEqual({
      contextWindow: 262144,
      source: '/models context_length',
    });
    expect(await p.contextWindow('missing')).toBeUndefined();
  });

  test('a token function is asked for a current token on each request', async () => {
    let issued = 0;
    const seen: (string | null)[] = [];
    const listing = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return Response.json({ data: [{ id: 'm', context_length: 8192 }] });
    }) as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'azure',
      baseUrl: 'https://acme.openai.azure.com/openai/v1',
      tier: 'remote',
      apiKey: async () => `token-${++issued}`,
      fetch: listing,
    });
    await p.contextWindow('m');
    await p.contextWindow('m');
    expect(seen).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  test('Azure OpenAI uses the v1 endpoint of the resource', () => {
    expect(azureOpenAIBaseUrl({ resource: 'acme' })).toBe(
      'https://acme.openai.azure.com/openai/v1',
    );
    expect(azureOpenAIBaseUrl({ baseUrl: 'https://acme.services.ai.azure.com/openai/v1' })).toBe(
      'https://acme.services.ai.azure.com/openai/v1',
    );
    expect(
      createProvider('az', ProviderConfig.parse({ type: 'azure-openai', resource: 'acme' })).tier,
    ).toBe('remote');
  });
});
