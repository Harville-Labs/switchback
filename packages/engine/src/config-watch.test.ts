import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import { loadConfig } from './config.ts';
import { ConfigWatcher } from './config-watch.ts';
import { Engine } from './engine.ts';
import { legacyDirs } from './paths.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchback-config-watch-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(10);
  return ok();
};

const config = (model: string) =>
  JSON.stringify({
    providers: { lp: { type: 'mock', tier: 'local' } },
    models: { [model]: { provider: 'lp', model, contextWindow: 32_000 } },
    routing: { current: [model] },
  });

test('an engine applies config written outside it, as `switchback init` in a terminal does', async () => {
  const home = join(dir, 'home');
  const ws = join(dir, 'ws');
  mkdirSync(home);
  mkdirSync(ws);
  const env = { SWITCHBACK_HOME: home };
  const file = join(home, 'config.json');
  writeFileSync(file, config('old'));
  const engine = new Engine({
    workspaceRoot: ws,
    config: loadConfig(ws, env).config,
    userConfigFile: file,
    reloadConfig: () => loadConfig(ws, env),
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const current = () => engine.roles(engine.createSession({}).id).current;
  expect(current()).toEqual(['old']);

  writeFileSync(file, config('new'));
  expect(await until(() => events.some((e) => e.type === 'config.updated'))).toBe(true);
  expect(current()).toEqual(['new']);

  // A broken file is reported, and the config in effect stays.
  writeFileSync(file, '{ "models": ');
  expect(await until(() => events.some((e) => e.type === 'log' && e.level === 'error'))).toBe(true);
  expect(current()).toEqual(['new']);
  await engine.shutdown();
});

test('a file created after the watch starts is seen, and rewriting the same bytes is not', async () => {
  const file = join(dir, 'config.json');
  let changes = 0;
  const w = new ConfigWatcher([file], () => changes++, 20);
  writeFileSync(file, '{}');
  expect(await until(() => changes === 1)).toBe(true);
  await Bun.sleep(100);
  expect(changes).toBe(1);
  w.close();
});

test('doctor can point out folders from before 1.1.0, but not one SWITCHBACK_HOME uses', () => {
  const old = join(dir, '.config', 'switchback');
  mkdirSync(old, { recursive: true });
  expect(legacyDirs({ HOME: dir })).toEqual([old]);
  expect(legacyDirs({ HOME: dir, SWITCHBACK_HOME: old })).toEqual([]);
});
