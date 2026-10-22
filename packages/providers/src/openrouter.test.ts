import { describe, expect, test } from 'bun:test';
import type { Message } from '@switchback/protocol';
import { flavorForUrl, OpenAICompatibleProvider } from './openai-compatible.ts';
import { capture, drain } from './openai-fixture.ts';
import { createProvider } from './registry.ts';
import { ProviderError } from './types.ts';

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
