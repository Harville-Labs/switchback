import { describe, expect, test } from 'bun:test';
import { OpenCodeProvider, openCodeApi } from './opencode.ts';
import { createProvider, ProviderConfig } from './registry.ts';
import { ScriptedProvider } from './scripted.ts';
import type { ChatEvent, ChatRequest } from './types.ts';

const request = (model: string): ChatRequest => ({
  model,
  system: 's',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  maxTokens: 100,
});

async function drain(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('which API OpenCode serves a model on', () => {
  test('by family, as OpenCode documents it, with overrides for new models', () => {
    expect(openCodeApi('kimi-k3')).toBe('chat');
    expect(openCodeApi('deepseek-v4-flash')).toBe('chat');
    expect(openCodeApi('claude-haiku-5-5')).toBe('messages');
    expect(openCodeApi('qwen3.8-max')).toBe('messages');
    expect(openCodeApi('gpt-6-sol')).toBe('responses');
    expect(openCodeApi('grok-4.7')).toBe('responses');
    expect(openCodeApi('gemini-3-pro')).toBeUndefined();
    expect(openCodeApi('kimi-k3', { 'kimi-k3': 'messages' })).toBe('messages');
  });
});

describe('OpenCode provider', () => {
  test('hands each request to the adapter for its model', async () => {
    const chat = new ScriptedProvider('oc', 'remote', [{ text: 'from chat' }]);
    const messages = new ScriptedProvider('oc', 'remote', [{ text: 'from messages' }]);
    const p = new OpenCodeProvider({
      id: 'oc',
      plan: 'go',
      apiKey: 'k',
      adapters: { chat, messages },
    });
    await drain(p.stream(request('glm-5.3')));
    await drain(p.stream(request('claude-haiku-5-5')));
    expect(chat.requests.map((r) => r.model)).toEqual(['glm-5.3']);
    expect(messages.requests.map((r) => r.model)).toEqual(['claude-haiku-5-5']);
  });

  test('chat models go to the plan’s endpoint with the OpenCode key', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
      const chunk = { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    }) as unknown as typeof fetch;
    const go = new OpenCodeProvider({ id: 'oc', plan: 'go', apiKey: 'sk-oc', fetch: fetchStub });
    await drain(go.stream(request('kimi-k3')));
    const zen = new OpenCodeProvider({ id: 'oc', plan: 'zen', apiKey: 'sk-oc', fetch: fetchStub });
    await drain(zen.stream(request('kimi-k3')));
    expect(seen).toEqual([
      { url: 'https://opencode.ai/zen/go/v1/chat/completions', auth: 'Bearer sk-oc' },
      { url: 'https://opencode.ai/zen/v1/chat/completions', auth: 'Bearer sk-oc' },
    ]);
  });

  test('without a key nothing is sent, and the error says how to fix it', async () => {
    const chat = new ScriptedProvider('oc', 'remote', [{ text: 'never' }]);
    const p = new OpenCodeProvider({ id: 'oc', plan: 'go', adapters: { chat } });
    await expect(drain(p.stream(request('kimi-k3')))).rejects.toThrow(
      'set OPENCODE_API_KEY or providers.oc.apiKey',
    );
    expect(chat.requests).toHaveLength(0);
    expect(await p.health()).toEqual({
      ok: false,
      detail: 'no API key (set OPENCODE_API_KEY or providers.oc.apiKey)',
    });
  });

  test("a model on Google's API is refused with what to do instead", async () => {
    const p = new OpenCodeProvider({ id: 'oc', plan: 'zen', apiKey: 'k' });
    await expect(drain(p.stream(request('gemini-3-pro')))).rejects.toThrow('Pick another model');
  });

  test('config: the Go plan by default, built into an OpenCode provider', () => {
    const config = ProviderConfig.parse({ type: 'opencode' });
    expect(config).toMatchObject({ type: 'opencode', plan: 'go' });
    expect(createProvider('oc', config)).toBeInstanceOf(OpenCodeProvider);
  });
});
