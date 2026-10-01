import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { FileSessionStore } from './store.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchback-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = SwitchbackConfig.parse({
  providers: { lp: { type: 'mock', tier: 'local' } },
  models: { local: { provider: 'lp', model: 'm' } },
});

function engine(workspaceRoot: string, store: FileSessionStore) {
  return new Engine({
    workspaceRoot,
    config,
    store,
    providers: new Map([['lp', new ScriptedProvider('lp', 'local', () => ({ text: 'ok' }))]]),
  });
}

test('sessions persist with their title and resume in a new engine', async () => {
  const sessionsDir = join(dir, 'sessions');
  const first = engine(dir, new FileSessionStore(sessionsDir));
  const unused = first.createSession({});
  const s = first.createSession({});
  await first.runTurn(s.id, 'refactor the parser');

  // Unused sessions leave no file.
  expect(existsSync(join(sessionsDir, `${unused.id}.jsonl`))).toBe(false);
  expect(readdirSync(sessionsDir)).toEqual([`${s.id}.jsonl`]);

  const second = engine(dir, new FileSessionStore(sessionsDir));
  const [listed] = second.listSessions();
  expect(listed).toMatchObject({ id: s.id, title: 'refactor the parser' });
  const got = second.getSession(s.id);
  expect(got.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  await second.runTurn(s.id, 'and add tests');
  expect(second.getSession(s.id).messages).toHaveLength(4);
});

test('listing is scoped to the workspace, newest first, and tolerates huge headers', async () => {
  const sessionsDir = join(dir, 'sessions');
  const store = new FileSessionStore(sessionsDir);
  const a = engine(join(dir, 'a'), store);
  const b = engine(join(dir, 'b'), store);
  const big = new Engine({
    workspaceRoot: join(dir, 'a'),
    config,
    store,
    instructions: 'x'.repeat(200_000), // system prompt > the 64 KB read chunk
    providers: new Map([['lp', new ScriptedProvider('lp', 'local', () => ({ text: 'ok' }))]]),
  });
  const s1 = a.createSession({});
  await a.runTurn(s1.id, 'first');
  const s2 = big.createSession({});
  await Bun.sleep(15);
  await big.runTurn(s2.id, 'second');
  const other = b.createSession({});
  await b.runTurn(other.id, 'elsewhere');

  expect(a.listSessions().map((x) => x.title)).toEqual(['second', 'first']);
  expect(b.listSessions().map((x) => x.title)).toEqual(['elsewhere']);
});
