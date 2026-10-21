import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchbackConfig } from './config.ts';
import {
  readEndpointModels,
  refreshDiscoveredModels,
  refreshEndpointModels,
  withEndpointModels,
} from './endpoint-models.ts';

let env: Record<string, string>;
beforeEach(() => {
  env = { SWITCHBACK_HOME: mkdtempSync(join(tmpdir(), 'switchback-endpoint-models-')) };
});
afterEach(() => rmSync(env.SWITCHBACK_HOME as string, { recursive: true, force: true }));

const BASE = 'http://10.0.0.5:8000/v1';
const config = SwitchbackConfig.parse({
  providers: {
    vllm: { type: 'openai-compatible', baseUrl: BASE, tier: 'local' },
    gateway: {
      type: 'openai-compatible',
      baseUrl: 'https://gateway.example.com/v1',
      listModels: false,
    },
    mine: { type: 'mock', tier: 'local' },
  },
  models: {
    big: { provider: 'vllm', model: 'acme/Big-1.5' },
    small: { provider: 'mine', model: 'small' },
  },
});

/** A server whose `GET /models` lists `ids`, or fails when `ids` is undefined. */
const serving = (ids: string[] | undefined, asked: string[] = []) =>
  (async (url: string | URL | Request) => {
    asked.push(String(url));
    if (!ids) throw new Error('connection refused');
    return Response.json({ data: ids.map((id) => ({ id })) });
  }) as typeof fetch;

describe('withEndpointModels', () => {
  test('adds what the endpoint serves that config does not name', () => {
    const merged = withEndpointModels(config, {
      vllm: {
        baseUrl: BASE,
        models: [{ id: 'acme/Big-1.5' }, { id: 'tiny', contextWindow: 8192 }],
      },
    });
    expect(merged.models.tiny).toMatchObject({
      provider: 'vllm',
      model: 'tiny',
      contextWindow: 8192,
    });
    // Configured under another alias: left as the user wrote it.
    expect(Object.values(merged.models).filter((m) => m.model === 'acme/Big-1.5')).toHaveLength(1);
  });

  test('a name another model has gets the provider in front', () => {
    const merged = withEndpointModels(config, {
      vllm: { baseUrl: BASE, models: [{ id: 'small' }] },
    });
    expect(merged.models.small?.provider).toBe('mine');
    expect(merged.models['vllm-small']).toMatchObject({ provider: 'vllm', model: 'small' });
  });

  test('a list from a different baseUrl is stale and ignored', () => {
    const merged = withEndpointModels(config, {
      vllm: { baseUrl: 'http://old.example.com/v1', models: [{ id: 'tiny' }] },
    });
    expect(merged.models.tiny).toBeUndefined();
  });
});

describe('refreshEndpointModels', () => {
  test('caches what each endpoint lists and reports what is new and gone', async () => {
    const asked: string[] = [];
    const first = await refreshEndpointModels(config, env, serving(['a', 'b'], asked));
    expect(first).toEqual({
      changed: true,
      endpoints: [{ provider: 'vllm', added: ['a', 'b'], removed: [] }],
    });
    // A provider set to `listModels: false` isn't asked.
    expect(asked).toEqual([`${BASE}/models`]);

    const second = await refreshEndpointModels(config, env, serving(['b', 'c']));
    expect(second.endpoints).toEqual([{ provider: 'vllm', added: ['c'], removed: ['a'] }]);
    expect(readEndpointModels(env).vllm?.models.map((m) => m.id)).toEqual(['b', 'c']);
    expect((await refreshEndpointModels(config, env, serving(['b', 'c']))).changed).toBe(false);
  });

  test('an endpoint that cannot be reached keeps its last list', async () => {
    await refreshEndpointModels(config, env, serving(['a']));
    const down = await refreshEndpointModels(config, env, serving(undefined));
    expect(down.changed).toBe(false);
    expect(down.endpoints[0]).toMatchObject({ provider: 'vllm', error: 'connection refused' });
    expect(readEndpointModels(env).vllm?.models).toEqual([{ id: 'a' }]);
  });
});

test('refreshDiscoveredModels reports plans and endpoints together', async () => {
  const both = SwitchbackConfig.parse({
    providers: { vllm: { type: 'openai-compatible', baseUrl: BASE }, codex: { type: 'codex' } },
    models: { big: { provider: 'vllm', model: 'acme/Big-1.5' } },
  });
  const got = await refreshDiscoveredModels(both, env, {
    fetch: serving(['a']),
    listPlans: async () => [{ id: 'gpt-7' }],
  });
  expect(got.changed).toBe(true);
  // A plan's first list isn't news: it replaces the catalog's stand-ins.
  expect(got.sources).toEqual([
    { provider: 'codex', added: [], removed: [] },
    { provider: 'vllm', added: ['a'], removed: [] },
  ]);
});
