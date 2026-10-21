import { describe, expect, test } from 'bun:test';
import { anthropicSampling } from './anthropic.ts';
import { geminiSampling } from './gemini.ts';
import { OpenAICompatibleProvider, samplingParams } from './openai-compatible.ts';
import { responsesSampling } from './openai-responses.ts';
import type { Sampling } from './types.ts';

const all: Sampling = {
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  body: { min_p: 0, chat_template_kwargs: { enable_thinking: false } },
};

describe('sampling settings', () => {
  test('an OpenAI-compatible server gets them on the wire, with body fields as given', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchStub = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({
      id: 'vllm',
      baseUrl: 'http://x/v1',
      tier: 'local',
      fetch: fetchStub,
    });
    const request = { model: 'm', system: 's', messages: [], tools: [], maxTokens: 100 };
    for await (const _ of p.stream({ ...request, sampling: all })) void _;
    expect(bodies[0]).toMatchObject({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
    for await (const _ of p.stream(request)) void _;
    expect(bodies[1]).not.toHaveProperty('temperature');
  });

  test('OpenAI and DeepSeek reject top_k, so it is left out for them', () => {
    expect(samplingParams('openai', { topK: 20, temperature: 1 })).toEqual({ temperature: 1 });
    expect(samplingParams('deepseek', { topK: 20 })).toEqual({});
    expect(samplingParams('openrouter', { topK: 20 })).toEqual({ top_k: 20 });
  });

  test('Claude takes them only without thinking, which fixes temperature at 1', () => {
    expect(anthropicSampling(all, false)).toEqual({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      ...all.body,
    });
    expect(anthropicSampling(all, true)).toEqual({ ...all.body });
  });

  test('the Responses API has no top_k; Gemini has no free-form body', () => {
    expect(responsesSampling(all)).toEqual({ temperature: 0.6, top_p: 0.95, ...all.body });
    expect(geminiSampling(all)).toEqual({ temperature: 0.6, topP: 0.95, topK: 20 });
  });

  test('none set sends nothing', () => {
    expect(samplingParams('generic', undefined)).toEqual({});
    expect(anthropicSampling(undefined, false)).toEqual({});
    expect(responsesSampling(undefined)).toEqual({});
    expect(geminiSampling(undefined)).toEqual({});
  });
});
