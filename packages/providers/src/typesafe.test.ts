import { describe, expect, test } from 'bun:test';
import { createProvider, ProviderConfig } from './registry.ts';
import { ProviderError } from './types.ts';
import { TypeSafeProvider } from './typesafe.ts';

/** Answers like the System One API (docs.typesafe.ai) and records what it was sent. */
function systemOne(reply: { status?: number; body: unknown }) {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({
      url,
      auth: new Headers(init?.headers).get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith('/v1/models'))
      return Response.json({
        models: [{ name: 'jev-latest', description: 'Jev', release_date: '2026-09-15' }],
      });
    return Response.json(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const levels = ['easy', 'medium', 'hard'] as const;

describe('TypeSafe (Jev)', () => {
  test('asks a score question and reports the rounded level, confidence, and usage', async () => {
    const { calls, fetchImpl } = systemOne({
      body: {
        model: 'jev-1.13.0',
        answers: {
          rating: {
            type: 'score',
            score: 1.62,
            confidence: 0.4,
            legend: { 0: 'easy', 1: 'medium', 2: 'hard' },
            probabilities: { 0: 0.0, 1: 0.38, 2: 0.62 },
          },
        },
        usage: { input_tokens: 120, output_tokens: 3 },
      },
    });
    const p = new TypeSafeProvider({
      id: 'typesafe',
      tier: 'remote',
      apiKey: 'ts-key',
      fetch: fetchImpl,
    });
    const r = await p.rate({
      model: 'jev-latest',
      instructions: 'How hard?',
      levels,
      text: 'refactor the scheduler',
    });
    expect(r).toEqual({
      level: 2,
      score: 1.62,
      confidence: 0.4,
      usage: { inputTokens: 120, outputTokens: 3 },
    });
    expect(calls[0]).toEqual({
      url: 'https://api.typesafe.ai/v1/systemone',
      auth: 'Bearer ts-key',
      body: {
        model: 'jev-latest',
        state: 'refactor the scheduler',
        questions: { rating: { type: 'score', instructions: 'How hard?', criteria: levels } },
      },
    });
  });

  test('health lists the models; a self-hosted server works through baseUrl', async () => {
    const { calls, fetchImpl } = systemOne({ body: {} });
    const p = new TypeSafeProvider({
      id: 'openjev',
      tier: 'local',
      baseUrl: 'http://localhost:8000',
      fetch: fetchImpl,
    });
    expect(await p.health()).toMatchObject({ ok: true, models: ['jev-latest'] });
    expect(calls[0]?.url).toBe('http://localhost:8000/v1/models');
  });

  test('without a key, a hosted provider reports it instead of calling out', async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const p = createProvider('typesafe', ProviderConfig.parse({ type: 'typesafe' }));
      expect(await p.health()).toEqual({
        ok: false,
        detail: 'no API key (set TYPESAFE_API_KEY or providers.typesafe.apiKey)',
      });
      expect(p.tier).toBe('remote');
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  test('a bad key is final; overload is worth trying again later', async () => {
    for (const [status, retryable] of [
      [401, false],
      [529, true],
      [429, true],
    ] as const) {
      const { fetchImpl } = systemOne({ status, body: { detail: 'nope' } });
      const p = new TypeSafeProvider({ id: 't', tier: 'remote', apiKey: 'k', fetch: fetchImpl });
      const err = await p
        .rate({ model: 'jev-latest', instructions: 'q', levels, text: 'x' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(retryable);
    }
  });

  test("can't chat", async () => {
    const p = new TypeSafeProvider({ id: 't', tier: 'remote', apiKey: 'k' });
    expect(p.decisionOnly).toBe(true);
    const run = async () => {
      for await (const _ of p.stream()) {
        // nothing
      }
    };
    expect(run()).rejects.toThrow('use it for routing.classifier.model');
  });
});
