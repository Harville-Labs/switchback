import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import { type Provider, ScriptedProvider } from '@switchback/providers';
import { CLASSIFIER_PROMPT, parseDifficulty } from './classifier.ts';
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

  function setup(rating: string | (() => Promise<never>), classifier: object | null = {}) {
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
    const rp = new ScriptedProvider('rp', 'remote', [{ text: 'remote answer' }]);
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow: 32_000 },
          remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
        },
        routing: classifier
          ? { classifier: { model: 'local', timeoutMs: 200, ...classifier } }
          : {},
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

  test('off unless configured; never runs on a remote model', async () => {
    const off = setup('{"difficulty":"hard"}', null);
    await off.engine.runTurn(off.engine.createSession({}).id, 'x');
    expect(off.lp.requests.some((r) => r.system === CLASSIFIER_PROMPT)).toBe(false);

    const remote = setup('{"difficulty":"hard"}', { model: 'remote' });
    await remote.engine.runTurn(remote.engine.createSession({}).id, 'x');
    expect(remote.rp.requests.some((r) => r.system === CLASSIFIER_PROMPT)).toBe(false);
    expect(
      remote.events.some(
        (e) => e.type === 'log' && /must be a configured local model/.test(e.message),
      ),
    ).toBe(true);
  });
});
