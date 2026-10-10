import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchbackClient } from '@switchback/client';
import { createTransportPair, type EngineEvent } from '@switchback/protocol';
import { loadConfig, parseJsonc, SwitchbackConfig } from '../config.ts';
import { Engine } from '../engine.ts';
import { serve } from '../server.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchback-setup-rpc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An engine with no config yet, as a first run has, and a client talking to it. */
async function connect() {
  const home = join(dir, 'home');
  const engine = new Engine({
    workspaceRoot: dir,
    config: SwitchbackConfig.parse({}),
    setup: { detect: async () => [], list: async () => [], env: { SWITCHBACK_HOME: home } },
    reloadConfig: () => loadConfig(dir, { SWITCHBACK_HOME: home }),
  });
  const [server, client] = createTransportPair();
  serve(engine, server);
  const c = new SwitchbackClient(client);
  await c.initialize({ name: 'test', version: '0' }, dir);
  const events: EngineEvent[] = [];
  c.on((e) => events.push(e));
  return { c, events, home };
}

type Ask = Extract<EngineEvent, { type: 'setup.ask' }>;

/** Answer each question as it comes, by its wording, until setup finishes. */
async function answerAll(
  c: SwitchbackClient,
  events: EngineEvent[],
  answers: [string, (ask: Ask) => boolean | string | number | number[] | null][],
) {
  const asked: string[] = [];
  for (let seen = 0; ; ) {
    const done = events.find((e) => e.type === 'setup.finished');
    if (done) return { done, asked };
    const next = events.slice(seen).find((e): e is Ask => e.type === 'setup.ask');
    if (!next) {
      await Bun.sleep(1);
      continue;
    }
    seen = events.indexOf(next) + 1;
    asked.push(next.question.question);
    const match = answers.find(([q]) => next.question.question.startsWith(q));
    if (!match) throw new Error(`unexpected question: ${next.question.question}`);
    await c.request('setup.answer', { requestId: next.requestId, value: match[1](next) });
  }
}

const index = (label: string) => (ask: Ask) =>
  'options' in ask.question ? ask.question.options.findIndex((o) => o.label.startsWith(label)) : -1;

test('a client runs the whole setup over the protocol, and the config is written', async () => {
  const { c, events, home } = await connect();
  await c.request('setup.start', {});
  const { done, asked } = await answerAll(c, events, [
    ['Do you have any local model endpoints?', () => false],
    ['Set up any remote providers?', () => true],
    ['Which provider?', index('DeepSeek')],
    ['Which model?', () => 0],
    ['Any additional remote providers?', () => false],
    ['Which model does what', index('Looks good')],
    ['Daily remote budget', () => ''],
    ['Monthly remote budget', () => 5],
    ['Write it?', () => true],
    ['Should any test or build commands', () => []],
  ]);
  expect(asked[0]).toBe('Do you have any local model endpoints?');
  expect(done).toMatchObject({ outcome: 'written', file: join(home, 'config.json') });
  const config = parseJsonc(readFileSync(join(home, 'config.json'), 'utf8')) as {
    providers: Record<string, { type: string }>;
    routing: { budget: { monthlyUsd: number } };
    permissions: { allow: string[] };
  };
  expect(config.providers.deepseek?.type).toBe('deepseek');
  expect(config.routing.budget.monthlyUsd).toBe(5);
  expect(config.permissions.allow).toContain('bash(git status:*)');
  // Applied live, so every client of a shared engine sees the new models.
  expect(events.some((e) => e.type === 'config.updated')).toBe(true);
  expect((await c.request('session.create', {})).id).toBeTruthy();
  // Clients draw these themselves: the roles and the config before it's written.
  const notes = events.flatMap((e) => (e.type === 'setup.note' ? [e.note.kind] : []));
  expect(notes).toContain('roles');
  expect(notes).toContain('config');
});

test('answering null cancels setup, and nothing is written', async () => {
  const { c, events, home } = await connect();
  await c.request('setup.start', {});
  const { done } = await answerAll(c, events, [
    ['Do you have any local model endpoints?', () => null],
  ]);
  expect(done).toMatchObject({ outcome: 'cancelled' });
  expect(existsSync(join(home, 'config.json'))).toBe(false);
});

test('a wrong kind of answer ends setup with a reason, not a crash', async () => {
  const { c, events } = await connect();
  await c.request('setup.start', {});
  const { done } = await answerAll(c, events, [
    ['Do you have any local model endpoints?', () => 'yes please'],
  ]);
  expect(done).toMatchObject({ outcome: 'failed', message: expect.stringContaining('wrong kind') });
});
