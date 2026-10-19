import { expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import {
  type ChatEvent,
  type Provider,
  ProviderError,
  type Script,
  ScriptedProvider,
} from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';

function setup(local: Script | Provider, retry: object = {}) {
  const config = SwitchbackConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
    models: {
      local: { provider: 'lp', model: 'small', contextWindow: 32_000 },
      remote: { provider: 'rp', model: 'big', contextWindow: 200_000 },
    },
    routing: { current: ['local'], escalate: [['remote']] },
    // Real delays would make these tests slow; the backoff itself is p-retry's.
    retry: { initialDelayMs: 1, maxDelayMs: 1, ...retry },
  });
  const lp =
    Array.isArray(local) || typeof local === 'function'
      ? new ScriptedProvider('lp', 'local', local)
      : local;
  const rp = new ScriptedProvider('rp', 'remote', [{ text: 'remote answer' }]);
  const engine = new Engine({
    workspaceRoot: '/tmp',
    config,
    providers: new Map<string, Provider>([
      ['lp', lp],
      ['rp', rp],
    ]),
  });
  const logs: string[] = [];
  engine.subscribe((e: EngineEvent) => e.type === 'log' && logs.push(e.message));
  return { engine, lp, rp, logs };
}

const unavailable = () => ({ error: new ProviderError('503 model is loading', 'lp', true) });

test('an unavailable model is retried until it answers, without falling back', async () => {
  const { engine, rp, logs } = setup([unavailable(), unavailable(), { text: 'local answer' }]);
  const s = engine.createSession({});
  const r = await engine.runTurn(s.id, 'hi');
  expect(r.text).toBe('local answer');
  expect(rp.requests).toHaveLength(0);
  expect(logs.filter((l) => l.includes('is unavailable'))).toEqual([
    'local is unavailable (503 model is loading); retry 1 of 5 in 1s',
    'local is unavailable (503 model is loading); retry 2 of 5 in 1s',
  ]);
});

test('after the last retry the router falls back to another model', async () => {
  const { engine, lp, rp } = setup(Array.from({ length: 4 }, unavailable), { attempts: 3 });
  const s = engine.createSession({});
  const r = await engine.runTurn(s.id, 'hi');
  expect(r.text).toBe('remote answer');
  expect((lp as ScriptedProvider).requests).toHaveLength(4);
  expect(rp.requests).toHaveLength(1);
});

test('a non-retryable failure is not retried', async () => {
  const { engine, lp, rp } = setup([{ error: new ProviderError('400 bad request', 'lp', false) }]);
  const s = engine.createSession({});
  const r = await engine.runTurn(s.id, 'hi');
  expect((lp as ScriptedProvider).requests).toHaveLength(1);
  expect(r.text).toBe('remote answer');
  expect(rp.requests).toHaveLength(1);
});

test('a failure after output has streamed is not retried, so text never repeats', async () => {
  let calls = 0;
  const flaky: Provider = {
    id: 'lp',
    tier: 'local',
    health: async () => ({ ok: true, detail: 'flaky' }),
    async *stream(): AsyncIterable<ChatEvent> {
      calls++;
      yield { type: 'text.delta', text: 'partial ' };
      throw new ProviderError('connection reset', 'lp', true);
    },
  };
  const { engine, rp } = setup(flaky);
  const s = engine.createSession({});
  const r = await engine.runTurn(s.id, 'hi');
  expect(calls).toBe(1);
  expect(r.text).toBe('remote answer');
  expect(rp.requests).toHaveLength(1);
});

test('cancelling the turn stops the retries', async () => {
  const { engine, lp } = setup(Array.from({ length: 10 }, unavailable), {
    initialDelayMs: 60_000,
    maxDelayMs: 60_000,
  });
  const s = engine.createSession({});
  const turn = engine.runTurn(s.id, 'hi');
  await Bun.sleep(50);
  engine.cancel(s.id);
  expect((await turn).stopReason).toBe('cancelled');
  expect((lp as ScriptedProvider).requests).toHaveLength(1);
});
