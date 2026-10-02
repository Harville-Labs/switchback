import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import { type Script, ScriptedProvider, type ScriptedTurn } from '@switchback/providers';
import { loadAgents } from './agents.ts';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { parseReview, turnDiff } from './review.ts';

describe('parseReview', () => {
  test('reads the JSON object, even inside a code fence', () => {
    const r = parseReview(
      'Here:\n```json\n{"verdict":"revise","summary":"off by one","issues":[{"file":"a.ts","line":3,"severity":"bug","comment":"use <="}]}\n```',
    );
    expect(r).toEqual({
      verdict: 'revise',
      summary: 'off by one',
      issues: [{ file: 'a.ts', line: 3, severity: 'bug', comment: 'use <=' }],
    });
  });

  test('a revise with only nits is an approve; unreadable is no verdict', () => {
    expect(
      parseReview(
        '{"verdict":"revise","summary":"s","issues":[{"file":"a","severity":"nit","comment":"rename"}]}',
      )?.verdict,
    ).toBe('approve');
    expect(parseReview('looks good to me')).toBeUndefined();
    expect(parseReview('{"verdict":"maybe"}')).toBeUndefined();
  });
});

describe('turnDiff', () => {
  test('new, changed, and deleted files; capped', () => {
    const d = turnDiff([
      { path: 'new.ts', before: undefined, after: 'x\n' },
      { path: 'same.ts', before: 'a\n', after: 'a\n' },
      { path: 'gone.ts', before: 'y\n', after: undefined },
    ]);
    expect(d).toContain('--- /dev/null\n+++ b/new.ts');
    expect(d).toContain('--- a/gone.ts\n+++ /dev/null');
    expect(d).not.toContain('same.ts');
    const big = turnDiff([{ path: 'b', before: '', after: 'l\n'.repeat(50) }], 10);
    expect(big).toContain('more diff lines not shown');
  });
});

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-review-'));
  writeFileSync(join(root, 'math.ts'), 'export const add = (a, b) => a - b;\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const APPROVE = '{"verdict":"approve","summary":"Correct.","issues":[]}';
const REVISE =
  '{"verdict":"revise","summary":"add still subtracts","issues":[{"file":"math.ts","line":1,"severity":"bug","comment":"use a + b"}]}';

const edit = (oldString: string, newString: string): ScriptedTurn => ({
  toolCalls: [{ name: 'edit', input: { path: 'math.ts', oldString, newString } }],
});

function setup(local: Script, remote: Script, config: object = {}) {
  const lp = new ScriptedProvider('lp', 'local', local);
  const rp = new ScriptedProvider('rp', 'remote', remote);
  const engine = new Engine({
    workspaceRoot: root,
    config: SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
      models: {
        local: { provider: 'lp', model: 'small', contextWindow: 32_000 },
        remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
      },
      routing: { start: ['local'], escalate: [['remote']] },
      permissions: { edit: 'allow' },
      review: { mode: 'auto' },
      ...config,
    }),
    providers: new Map([
      ['lp', lp],
      ['rp', rp],
    ]),
    agents: loadAgents([]).agents,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, lp, rp, events };
}

const reviews = (events: EngineEvent[]) =>
  events.filter(
    (e): e is Extract<EngineEvent, { type: 'review.completed' }> => e.type === 'review.completed',
  );

describe('draft locally, review with a stronger model', () => {
  test('a local edit is reviewed; approve ends the turn', async () => {
    const { engine, rp, events } = setup(
      [edit('a - b', 'a + b'), { text: 'Fixed add.' }],
      [{ text: APPROVE }],
    );
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'fix add');
    expect(r).toMatchObject({ stopReason: 'end_turn', text: 'Fixed add.' });
    expect(reviews(events)).toMatchObject([{ verdict: 'approve', round: 1, summary: 'Correct.' }]);
    const sent = JSON.stringify(rp.requests[0]?.messages);
    expect(sent).toContain('fix add');
    expect(sent).toContain('Fixed add.');
    expect(sent).toContain('-export const add = (a, b) => a - b;');
    expect(sent).toContain('+export const add = (a, b) => a + b;');
    expect(rp.requests[0]?.tools).toEqual([]);
    expect(events.find((e) => e.type === 'route.decided' && e.rule === 'review')).toMatchObject({
      tier: 'remote',
      reason: 'reviewing 1 changed file',
    });
    expect(engine.usage('today').byRule?.find((x) => x.key === 'review')?.calls).toBe(1);
  });

  test('revise: the findings go back to the local model, which fixes them; then approve', async () => {
    const { engine, lp, events } = setup(
      [edit('a - b', 'a * b'), { text: 'Done.' }, edit('a * b', 'a + b'), { text: 'Now adds.' }],
      [{ text: REVISE }, { text: APPROVE }],
    );
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'fix add');
    expect(r.text).toBe('Now adds.');
    expect(readFileSync(join(root, 'math.ts'), 'utf8')).toContain('a + b');
    expect(reviews(events).map((e) => e.verdict)).toEqual(['revise', 'approve']);
    // The fix round saw the findings.
    expect(JSON.stringify(lp.requests[2]?.messages.at(-1))).toContain('math.ts:1 [bug] use a + b');
    const feedback = engine
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .find((p) => p.type === 'text' && p.review);
    expect(feedback).toMatchObject({ review: { round: 1, model: { model: 'claude-opus-5' } } });
    // The second review sees the whole turn's change, from the original file.
    expect(events.filter((e) => e.type === 'turn.completed')).toHaveLength(1);
  });

  test('stops after review.maxRounds', async () => {
    const { engine, events } = setup(
      [edit('a - b', 'a * b'), { text: 'Done.' }, edit('a * b', 'a / b'), { text: 'Again.' }],
      [{ text: REVISE }, { text: REVISE }, { text: APPROVE }],
      { review: { mode: 'auto', maxRounds: 2 } },
    );
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'fix add');
    expect(reviews(events).map((e) => e.verdict)).toEqual(['revise', 'revise']);
  });

  test('no review without edits; a model never reviews its own work', async () => {
    const a = setup([{ text: 'just talking' }], [{ text: APPROVE }]);
    await a.engine.runTurn(a.engine.createSession({}).id, 'hi');
    expect(reviews(a.events)).toHaveLength(0);

    // The remote model edited, and it's the only reviewer.
    const b = setup([], [edit('a - b', 'a + b'), { text: 'done' }, { text: APPROVE }]);
    await b.engine.runTurn(b.engine.createSession({}).id, 'fix add', 'remote');
    expect(reviews(b.events)).toMatchObject([{ verdict: 'skipped' }]);
    expect(reviews(b.events)[0]?.summary).toContain('never reviews its own work');
  });

  test('never remote when remote models are off or for a private session', async () => {
    const a = setup([edit('a - b', 'a + b'), { text: 'ok' }], [{ text: APPROVE }], {
      routing: { start: ['local'], escalate: [['remote']], allowRemote: false },
    });
    await a.engine.runTurn(a.engine.createSession({}).id, 'fix add');
    expect(reviews(a.events)).toMatchObject([
      { verdict: 'skipped', summary: 'remote models are turned off (routing.allowRemote)' },
    ]);
    expect(a.rp.requests).toHaveLength(0);

    writeFileSync(join(root, 'math.ts'), 'export const add = (a, b) => a - b;\n');
    const b = setup([edit('a - b', 'a + b'), { text: 'ok' }], [{ text: APPROVE }], {
      privacy: { localOnlyPaths: ['math.ts'] },
    });
    await b.engine.runTurn(b.engine.createSession({}).id, 'fix add');
    expect(reviews(b.events)[0]).toMatchObject({ verdict: 'skipped' });
    expect(reviews(b.events)[0]?.summary).toContain('private content');
    expect(b.rp.requests).toHaveLength(0);
  });

  test('a bigger local model can be the reviewer', async () => {
    const lp = new ScriptedProvider('lp', 'local', [edit('a - b', 'a + b'), { text: 'ok' }]);
    const big = new ScriptedProvider('big', 'local', [{ text: APPROVE }]);
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' }, big: { type: 'mock', tier: 'local' } },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow: 32_000 },
          reviewer: { provider: 'big', model: 'large-local', contextWindow: 128_000 },
        },
        permissions: { edit: 'allow' },
        routing: { start: ['local'], allowRemote: false },
        review: { mode: 'auto', models: ['reviewer'] },
      }),
      providers: new Map([
        ['lp', lp],
        ['big', big],
      ]),
      agents: loadAgents([]).agents,
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.runTurn(engine.createSession({}).id, 'fix add');
    expect(reviews(events)).toMatchObject([{ verdict: 'approve' }]);
    expect(engine.usage('today').byTier.remote.costUsd).toBe(0);
  });

  test('the per-prompt flag overrides review.mode both ways', async () => {
    const off = setup([edit('a - b', 'a + b'), { text: 'ok' }], [{ text: APPROVE }], {
      review: { mode: 'off' },
    });
    const s = off.engine.createSession({});
    off.engine.prompt({ sessionId: s.id, text: 'fix add', review: true });
    await Bun.sleep(50);
    expect(reviews(off.events)).toHaveLength(1);

    writeFileSync(join(root, 'math.ts'), 'export const add = (a, b) => a - b;\n');

    const on = setup([edit('a - b', 'a + b'), { text: 'ok' }], [{ text: APPROVE }]);
    await on.engine.runTurn(
      on.engine.createSession({}).id,
      'fix add',
      'auto',
      undefined,
      undefined,
      [],
      {
        review: false,
      },
    );
    // The edit happened; only the review was turned off.
    expect(readFileSync(join(root, 'math.ts'), 'utf8')).toContain('a + b');
    expect(reviews(on.events)).toHaveLength(0);
  });

  test('a reviewer failure is reported and the turn still succeeds', async () => {
    const { engine, events } = setup(
      [edit('a - b', 'a + b'), { text: 'ok' }],
      [{ error: new Error('overloaded') }],
    );
    const r = await engine.runTurn(engine.createSession({}).id, 'fix add');
    expect(r.stopReason).toBe('end_turn');
    expect(reviews(events)[0]).toMatchObject({ verdict: 'skipped' });
    expect(reviews(events)[0]?.summary).toContain('overloaded');
  });
});

describe('review ladder', () => {
  test('defaults to the escalation ladder; unresolved findings move up to the next reviewer', async () => {
    const lp = new ScriptedProvider('lp', 'local', [
      edit('a - b', 'a * b'),
      { text: 'done' },
      edit('a * b', 'a + b'),
      { text: 'fixed' },
      { text: 'fixed again' },
    ]);
    const gp = new ScriptedProvider('gp', 'local', [{ text: REVISE }, { text: REVISE }]);
    const rp = new ScriptedProvider('rp', 'remote', [{ text: APPROVE }]);
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: {
          lp: { type: 'mock', tier: 'local' },
          gp: { type: 'mock', tier: 'local' },
          rp: { type: 'mock', tier: 'remote' },
        },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow: 32_000 },
          large: { provider: 'gp', model: 'large-local', contextWindow: 128_000 },
          remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
        },
        routing: { start: ['local'], escalate: ['large', 'remote'] },
        permissions: { edit: 'allow' },
        review: { mode: 'auto', maxRounds: 4 },
      }),
      providers: new Map([
        ['lp', lp],
        ['gp', gp],
        ['rp', rp],
      ]),
      agents: loadAgents([]).agents,
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.runTurn(engine.createSession({}).id, 'fix add');
    expect(reviews(events).map((r) => [r.model?.model, r.verdict])).toEqual([
      ['large-local', 'revise'],
      ['large-local', 'revise'],
      ['claude-opus-5', 'approve'],
    ]);
    // The free local reviewer did the first two reviews; only the last one cost anything.
    expect(rp.requests).toHaveLength(1);
  });

  test('a reviewer that is down or not allowed is passed over for the next', async () => {
    const a = setup([edit('a - b', 'a + b'), { text: 'ok' }], [{ text: APPROVE }], {
      models: {
        local: { provider: 'lp', model: 'small', contextWindow: 32_000 },
        ghost: { provider: 'lp', model: 'missing', contextWindow: 32_000 },
        remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
      },
      review: { mode: 'auto', models: [['local'], ['remote']] },
    });
    await a.engine.runTurn(a.engine.createSession({}).id, 'fix add');
    // `local` wrote the change, so `remote` reviews.
    expect(reviews(a.events)).toMatchObject([
      { verdict: 'approve', model: { model: 'claude-opus-5' } },
    ]);
  });

  test('no reviewer configured: skipped with the reason', async () => {
    const a = setup([edit('a - b', 'a + b'), { text: 'ok' }], [], {
      routing: { start: ['local'] },
    });
    await a.engine.runTurn(a.engine.createSession({}).id, 'fix add');
    expect(reviews(a.events)[0]?.summary).toContain('no reviewer is configured');
  });
});
