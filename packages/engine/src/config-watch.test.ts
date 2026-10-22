import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import { loadConfig } from './config.ts';
import { ConfigWatcher } from './config-watch.ts';
import { refreshDiscoveredModels } from './endpoint-models.ts';
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

test('models.refresh asks the endpoints and every client gets the new list', async () => {
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = { SWITCHBACK_HOME: home };
  const file = join(home, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      providers: { box: { type: 'openai-compatible', baseUrl: 'http://10.0.0.5:8000/v1' } },
      models: { big: { provider: 'box', model: 'big' } },
      routing: { current: ['big'] },
    }),
  );
  const listing = (async () =>
    Response.json({ data: [{ id: 'big' }, { id: 'tiny' }] })) as unknown as typeof fetch;
  const engine = new Engine({
    workspaceRoot: dir,
    config: loadConfig(dir, env).config,
    userConfigFile: file,
    reloadConfig: () => loadConfig(dir, env),
    refreshModels: async () =>
      (await refreshDiscoveredModels(loadConfig(dir, env).config, env, { fetch: listing })).sources,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));

  const got = await engine.refreshModels();
  expect(got.sources).toEqual([{ provider: 'box', added: ['big', 'tiny'], removed: [] }]);
  expect(got.models.map((m) => m.alias)).toEqual(['big', 'tiny']);
  const updated = events.find((e) => e.type === 'config.updated');
  expect(updated?.type === 'config.updated' && updated.models?.map((m) => m.alias)).toEqual([
    'big',
    'tiny',
  ]);
  await engine.shutdown();
});

test('a file created after the watch starts is seen, and rewriting the same bytes is not', async () => {
  const file = join(dir, 'config.json');
  let changes = 0;
  const w = new ConfigWatcher([file], () => changes++, 20);
  // macOS starts a folder watch asynchronously; a write in its first moments can go unseen.
  await Bun.sleep(100);
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
