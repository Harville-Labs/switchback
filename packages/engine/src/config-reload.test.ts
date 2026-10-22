import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchbackClient } from '@switchback/client';
import { createTransportPair, type EngineEvent } from '@switchback/protocol';
import { loadConfig } from './config.ts';
import { refreshDiscoveredModels } from './endpoint-models.ts';
import { Engine } from './engine.ts';
import { OrgPolicy } from './org/policy.ts';
import { legacyDirs } from './paths.ts';
import { serve } from './server.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchback-config-reload-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (model: string, extra: string[] = []) =>
  JSON.stringify({
    providers: { lp: { type: 'mock', tier: 'local' } },
    models: Object.fromEntries(
      [model, ...extra].map((m) => [m, { provider: 'lp', model: m, contextWindow: 32_000 }]),
    ),
    routing: { current: [model] },
  });

/** An engine over a transport, reading its user config from `home/config.json`. */
async function engineOverWire(org?: OrgPolicy) {
  const home = join(dir, 'home');
  const ws = join(dir, 'ws');
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  const env = { SWITCHBACK_HOME: home };
  const load = () => loadConfig(ws, env, [], org ?? null);
  const { config, rules } = load();
  const engine = new Engine({
    workspaceRoot: ws,
    config,
    rules,
    userConfigFile: join(home, 'config.json'),
    reloadConfig: load,
  });
  const [serverSide, clientSide] = createTransportPair();
  serve(engine, serverSide);
  const client = new SwitchbackClient(clientSide);
  await client.initialize({ name: 'test', version: '0' }, ws);
  const events: EngineEvent[] = [];
  client.on((e) => events.push(e));
  const current = () => engine.roles(engine.createSession({}).id).current;
  return { engine, client, events, current };
}

test('config edits wait for config.reload, which says what changed', async () => {
  const file = join(dir, 'home', 'config.json');
  mkdirSync(join(dir, 'home'));
  writeFileSync(file, config('old'));
  const { engine, client, events, current } = await engineOverWire();
  expect(current()).toEqual(['old']);

  writeFileSync(file, config('new'));
  await Bun.sleep(300);
  expect(current()).toEqual(['old']);
  expect(events.some((e) => e.type === 'config.updated')).toBe(false);

  const got = await client.request('config.reload', {});
  expect(got.changed).toEqual(['models', 'routing']);
  expect(got.models.map((m) => m.alias)).toEqual(['new']);
  expect(current()).toEqual(['new']);
  expect(events.some((e) => e.type === 'config.updated')).toBe(true);

  expect((await client.request('config.reload', {})).changed).toEqual([]);

  // A broken file is reported with its path, and the config in effect stays.
  writeFileSync(file, '{ "models": ');
  const err = await client.request('config.reload', {}).catch((e: Error) => e);
  expect((err as Error).message).toContain(file);
  expect((err as Error).message).toContain('The config in effect stays');
  expect(current()).toEqual(['new']);
  await engine.shutdown();
});

test('organization-enforced settings still win after a reload', async () => {
  const file = join(dir, 'home', 'config.json');
  mkdirSync(join(dir, 'home'));
  writeFileSync(file, config('mine', ['theirs']));
  const org = OrgPolicy.parse({
    version: 1,
    org: { id: 'acme', name: 'Acme' },
    enforced: { routing: { current: ['theirs'] } },
  });
  const { engine, client, current } = await engineOverWire(org);
  expect(current()).toEqual(['theirs']);

  writeFileSync(file, config('mine', ['theirs', 'extra']));
  const got = await client.request('config.reload', {});
  expect(got.changed).toEqual(['models']);
  expect(current()).toEqual(['theirs']);
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

test('doctor can point out folders from before 1.1.0, but not one SWITCHBACK_HOME uses', () => {
  const old = join(dir, '.config', 'switchback');
  mkdirSync(old, { recursive: true });
  expect(legacyDirs({ HOME: dir })).toEqual([old]);
  expect(legacyDirs({ HOME: dir, SWITCHBACK_HOME: old })).toEqual([]);
});
