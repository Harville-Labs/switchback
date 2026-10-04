import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import { type Provider, type RateRequest, ScriptedProvider } from '@switchback/providers';
import { CLASSIFIER_PROMPT, DIFFICULTY_RUBRIC, parseDifficulty } from './classifier.ts';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';

test('parses JSON, JSON wrapped in chatter or think tags, and bare keywords', () => {
  expect(parseDifficulty('{"difficulty":"hard","reason":"race"}')).toEqual({
    level: 'hard',
    reason: 'race',
  });
  expect(
    parseDifficulty('<think>maybe easy?</think>Sure! {"difficulty": "medium", "reason": "x"}'),
  ).toMatchObject({ level: 'medium' });
  expect(parseDifficulty('I would say EASY.')).toEqual({ level: 'easy', reason: '' });
  expect(parseDifficulty('no idea')).toBeUndefined();
});

describe('engine classifier', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'switchback-classify-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function setup(
    rating: string | (() => Promise<never>),
    classifier: object | null = {},
    routing: object = {},
  ) {
    const lp = new ScriptedProvider('lp', 'local', (req) =>
      req.system === CLASSIFIER_PROMPT
        ? { text: typeof rating === 'string' ? rating : '' }
        : { text: 'local answer' },
    );
    if (typeof rating !== 'string') {
      const original = lp.stream.bind(lp);
      lp.stream = async function* (req) {
        if (req.system === CLASSIFIER_PROMPT) {
          await new Promise((_, reject) =>
            req.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          );
        }
        yield* original(req);
      };
    }
    const rp = new ScriptedProvider('rp', 'remote', (req) =>
      req.system === CLASSIFIER_PROMPT
        ? { text: typeof rating === 'string' ? rating : '' }
        : { text: 'remote answer' },
    );
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow: 32_000 },
          remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
        },
        routing: {
          start: ['local'],
          escalate: [['remote']],
          ...(classifier ? { classifier: { model: 'local', timeoutMs: 200, ...classifier } } : {}),
          ...routing,
        },
      }),
      providers: new Map<string, Provider>([
        ['lp', lp],
        ['rp', rp],
      ]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    return { engine, lp, rp, events };
  }
  const firstRoute = (events: EngineEvent[]) => events.find((e) => e.type === 'route.decided');

  test('a hard prompt starts remote; the classifier call is local and recorded', async () => {
    const { engine, events } = setup('{"difficulty":"hard","reason":"cross-module refactor"}');
    const r = await engine.runTurn(engine.createSession({}).id, 'migrate the ORM');
    expect(r.text).toBe('remote answer');
    expect(firstRoute(events)).toMatchObject({ rule: 'classifier', tier: 'remote' });
    // The rating call is local and free; the escalated call is billed under `classifier`.
    const rows = engine.usage('today').byRule ?? [];
    expect(rows.find((row) => row.key === 'classify')).toMatchObject({ calls: 1, costUsd: 0 });
    expect(rows.find((row) => row.key === 'classifier')).toMatchObject({ calls: 1 });
  });

  test('an easy prompt stays local', async () => {
    const { engine, events } = setup('{"difficulty":"easy","reason":"lookup"}');
    expect((await engine.runTurn(engine.createSession({}).id, 'where is main?')).text).toBe(
      'local answer',
    );
    expect(firstRoute(events)).toMatchObject({ rule: 'default', tier: 'local' });
  });

  test('a classifier that times out never delays or changes routing', async () => {
    const { engine, events } = setup(() => Promise.reject());
    const started = performance.now();
    await engine.runTurn(engine.createSession({}).id, 'anything');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(firstRoute(events)).toMatchObject({ rule: 'default' });
  });

  test('off unless configured; a remote classifier follows the remote rules', async () => {
    const off = setup('{"difficulty":"hard"}', null);
    await off.engine.runTurn(off.engine.createSession({}).id, 'x');
    expect(off.lp.requests.some((r) => r.system === CLASSIFIER_PROMPT)).toBe(false);

    // Any model can classify (ADR 0015); a remote one is billed as remote...
    const remote = setup('{"difficulty":"easy"}', { model: 'remote' });
    await remote.engine.runTurn(remote.engine.createSession({}).id, 'x');
    expect(remote.rp.requests.some((r) => r.system === CLASSIFIER_PROMPT)).toBe(true);
    expect(
      remote.engine.usage().byRule?.find((r) => r.key === 'classify')?.costUsd,
    ).toBeGreaterThan(0);

    // ...and never runs when remote models are turned off.
    const off2 = setup('{"difficulty":"hard"}', { model: 'remote' }, { allowRemote: false });
    await off2.engine.runTurn(off2.engine.createSession({}).id, 'x');
    expect(off2.rp.requests).toHaveLength(0);
  });

  test('a decision model (Jev) rates on the rubric, priced and never chatted with', async () => {
    const asked: RateRequest[] = [];
    const jev: Provider = {
      id: 'typesafe',
      tier: 'remote',
      decisionOnly: true,
      health: async () => ({ ok: true, detail: 'ok' }),
      // biome-ignore lint/correctness/useYield: a decision model can't chat.
      async *stream() {
        throw new Error('chatted with a decision model');
      },
      rate: async (req) => {
        asked.push(req);
        return {
          level: 2,
          score: 1.7,
          confidence: 0.6,
          usage: { inputTokens: 1_000_000, outputTokens: 1 },
        };
      },
    };
    const lp = new ScriptedProvider('lp', 'local', () => ({ text: 'local answer' }));
    const rp = new ScriptedProvider('rp', 'remote', () => ({ text: 'remote answer' }));
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: {
          lp: { type: 'mock', tier: 'local' },
          rp: { type: 'mock', tier: 'remote' },
          typesafe: { type: 'typesafe', apiKey: 'k' },
        },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow: 32_000 },
          remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
          jev: { provider: 'typesafe', model: 'jev-latest' },
        },
        routing: { start: ['local'], escalate: [['remote']], classifier: { model: 'jev' } },
      }),
      providers: new Map<string, Provider>([
        ['lp', lp],
        ['rp', rp],
        ['typesafe', jev],
      ]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const r = await engine.runTurn(engine.createSession({}).id, 'migrate the ORM');
    expect(r.text).toBe('remote answer');
    expect(firstRoute(events)).toMatchObject({ rule: 'classifier', tier: 'remote' });
    expect(asked[0]).toMatchObject({ model: 'jev-latest', text: 'migrate the ORM' });
    expect(asked[0]?.levels).toEqual(DIFFICULTY_RUBRIC.levels);
    // A million input tokens at Jev's list price.
    const classify = engine.usage('today').byRule?.find((row) => row.key === 'classify');
    expect(classify?.costUsd).toBeCloseTo(0.042, 6);
  });
});
