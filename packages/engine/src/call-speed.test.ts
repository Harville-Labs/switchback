import { expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import { ScriptedProvider } from '@switchback/providers';
import { callSpeed } from './agent-loop.ts';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { groupUsage, type LedgerEntry } from './ledger.ts';

test('speed is measured from the first token, and not for tiny answers', () => {
  // 100 tokens, first token at 500 ms, done at 2.5 s: 50 tok/s, not 40.
  expect(callSpeed(100, 0, 500, 2_500)).toEqual({
    outputTokens: 100,
    tokensPerSecond: 50,
    firstTokenMs: 500,
    decodeMs: 2_000,
  });
  // Nothing streamed: the whole call.
  expect(callSpeed(100, 0, undefined, 4_000).tokensPerSecond).toBe(25);
  expect(callSpeed(3, 0, 10, 20)).toEqual({ outputTokens: 3, firstTokenMs: 10 });
});

test('a per-model rate averages over timed calls only', () => {
  const entry = (out: number, decodeMs?: number): LedgerEntry => ({
    ts: '',
    sessionId: 's',
    tier: 'local',
    model: { provider: 'lp', model: 'small' },
    usage: { inputTokens: 0, outputTokens: out },
    costUsd: 0,
    savingsUsd: 0,
    ...(decodeMs ? { decodeMs } : {}),
  });
  const [row] = groupUsage([entry(100, 1_000), entry(300, 1_000), entry(5_000)], () => 'm');
  expect(row?.tokensPerSecond).toBe(200);
});

test('every model call reports its stats', async () => {
  const config = SwitchbackConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' } },
    models: { local: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
    routing: { start: ['local'] },
  });
  const lp = new ScriptedProvider('lp', 'local', [{ text: 'hello there' }]);
  const engine = new Engine({ workspaceRoot: '/tmp', config, providers: new Map([['lp', lp]]) });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  await engine.runTurn(engine.createSession({}).id, 'hi');
  expect(events.find((e) => e.type === 'call.stats')).toMatchObject({
    model: { provider: 'lp', model: 'small' },
    tier: 'local',
  });
});
