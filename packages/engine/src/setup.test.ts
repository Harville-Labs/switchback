import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeContextWindow } from '@harness/providers';
import { HarnessConfig, loadConfig, parseJsonc } from './config.ts';
import {
  buildSetupConfig,
  detectLocalServers,
  OLLAMA_DEFAULT_CONTEXT,
  writeConfigLayer,
} from './setup.ts';

/** A fetch that answers like the given servers and refuses everything else. */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let key = url;
    if (url.endsWith('/api/show')) key = `${url}#${JSON.parse(String(init?.body)).model}`;
    if (!(key in routes)) throw new TypeError('connection refused');
    return Response.json(routes[key]);
  }) as typeof fetch;
}

describe('detectLocalServers', () => {
  test('reads Ollama models, tool capability, and the context it will actually load', async () => {
    const servers = await detectLocalServers({
      env: {},
      fetch: fakeFetch({
        'http://localhost:11434/api/tags': { models: [{ name: 'coder:7b' }, { name: 'chat:3b' }] },
        'http://localhost:11434/api/show#coder:7b': {
          capabilities: ['completion', 'tools'],
          model_info: { 'qwen2.context_length': 131072 },
          parameters: 'num_ctx 32768\nstop "<|im_end|>"',
        },
        'http://localhost:11434/api/show#chat:3b': {
          capabilities: ['completion'],
          model_info: { 'llama.context_length': 8192 },
        },
      }),
    });
    expect(servers).toHaveLength(1);
    const [ollama] = servers;
    expect(ollama?.baseUrl).toBe('http://localhost:11434/v1');
    expect(ollama?.models).toEqual([
      {
        id: 'coder:7b',
        contextWindow: 32768,
        maxContext: 131072,
        tools: true,
        contextSource: 'Ollama num_ctx',
      },
      {
        id: 'chat:3b',
        contextWindow: OLLAMA_DEFAULT_CONTEXT,
        maxContext: 8192,
        tools: false,
        contextSource: `Ollama default (${OLLAMA_DEFAULT_CONTEXT})`,
      },
    ]);
    expect(ollama?.note).toContain('OLLAMA_CONTEXT_LENGTH');
  });

  test('honors OLLAMA_CONTEXT_LENGTH and reads vLLM max_model_len', async () => {
    const servers = await detectLocalServers({
      env: { OLLAMA_CONTEXT_LENGTH: '16384' },
      fetch: fakeFetch({
        'http://localhost:11434/api/tags': { models: [{ name: 'm' }] },
        'http://localhost:11434/api/show#m': { model_info: { 'x.context_length': 65536 } },
        'http://localhost:8000/v1/models': { data: [{ id: 'Qwen/Coder', max_model_len: 40960 }] },
      }),
    });
    expect(servers.map((s) => s.kind)).toEqual(['ollama', 'vllm']);
    expect(servers[0]?.models[0]?.contextWindow).toBe(16384);
    expect(servers[0]?.note).toBeUndefined();
    expect(servers[1]?.models[0]).toMatchObject({ id: 'Qwen/Coder', contextWindow: 40960 });
  });

  test('returns nothing when no server is running', async () => {
    expect(await detectLocalServers({ fetch: fakeFetch({}) })).toEqual([]);
  });
});

describe('buildSetupConfig', () => {
  const local = {
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'coder:7b',
    contextWindow: 32768,
  };

  test('local + Bedrock points every Claude alias at Bedrock with prefixed IDs', () => {
    const layer = buildSetupConfig({
      locals: [local],
      remotes: [{ kind: 'bedrock', model: 'claude-sonnet-5', region: 'us-west-2' }],
      escalationPolicy: 'ask',
      budget: { dailyUsd: 3 },
    });
    const parsed = HarnessConfig.parse(layer);
    expect(parsed.models.remote).toMatchObject({
      provider: 'bedrock',
      model: 'anthropic.claude-sonnet-5',
    });
    expect(parsed.models.haiku?.model).toBe('anthropic.claude-haiku-4-5');
    expect(parsed.routing).toMatchObject({
      mode: 'auto',
      budget: { dailyUsd: 3 },
      escalation: { policy: 'ask' },
    });
    expect(parsed.providers.ollama).toMatchObject({ type: 'openai-compatible', tier: 'local' });
  });

  test('every hosted provider gets the same treatment', () => {
    for (const [kind, model] of [
      ['anthropic', 'claude-sonnet-5'],
      ['openai', 'gpt-6-sol'],
      ['deepseek', 'deepseek-flash'],
    ] as const) {
      const parsed = HarnessConfig.parse(
        buildSetupConfig({ locals: [local], remotes: [{ kind, model }], escalationPolicy: 'auto' }),
      );
      expect(parsed.providers[kind]?.type).toBe(kind);
      expect(parsed.models.remote).toMatchObject({ provider: kind, model });
      for (const alias of ['opus', 'sonnet', 'haiku'])
        expect(parsed.models[alias]?.provider).toBe(kind);
    }
  });

  test('DeepSeek models get an effort so thinking mode is on', () => {
    const layer = buildSetupConfig({
      locals: [],
      remotes: [{ kind: 'deepseek', model: 'deepseek-v4-pro' }],
      escalationPolicy: 'auto',
    });
    expect((layer.models as Record<string, { effort?: string }>).remote?.effort).toBe('high');
  });

  test('any OpenAI-compatible API can be the remote', () => {
    const parsed = HarnessConfig.parse(
      buildSetupConfig({
        locals: [local],
        remotes: [
          {
            kind: 'openai-compatible',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'qwen/qwen3-coder',
            apiKeyEnv: 'OPENROUTER_API_KEY',
            contextWindow: 262144,
          },
        ],
        escalationPolicy: 'auto',
      }),
    );
    expect(parsed.providers.remote).toMatchObject({
      type: 'openai-compatible',
      tier: 'remote',
      apiKey: '{env:OPENROUTER_API_KEY}',
    });
    expect(parsed.models.remote).toMatchObject({
      model: 'qwen/qwen3-coder',
      contextWindow: 262144,
    });
  });

  test('remote-only and local-only set the routing mode', () => {
    const remoteOnly = buildSetupConfig({
      locals: [],
      remotes: [{ kind: 'anthropic', model: 'claude-opus-5' }],
      escalationPolicy: 'auto',
    });
    const localOnly = buildSetupConfig({
      locals: [local],
      remotes: [],
      escalationPolicy: 'auto',
    });
    expect((remoteOnly.routing as { mode: string }).mode).toBe('remote-only');
    expect((localOnly.routing as { mode: string }).mode).toBe('local-only');
  });

  test('several local servers and remote providers become ordered chains', () => {
    const parsed = HarnessConfig.parse(
      buildSetupConfig({
        locals: [
          local,
          { ...local, model: 'coder:32b', contextWindow: 65536 }, // same server, bigger model
          {
            providerId: 'ollama',
            baseUrl: 'http://gpu:11434/v1',
            model: 'big',
            contextWindow: 131072,
          },
        ],
        remotes: [
          { kind: 'openai', model: 'gpt-6-sol' },
          { kind: 'deepseek', model: 'deepseek-v4-pro' },
          { kind: 'anthropic', model: 'claude-sonnet-5' },
        ],
        escalationPolicy: 'auto',
      }),
    );
    expect(parsed.routing.local).toEqual(['local', 'local-2', 'local-3']);
    expect(parsed.routing.remote).toEqual(['remote', 'remote-2', 'remote-3']);
    // One provider per server; a second Ollama server gets its own ID.
    expect(parsed.models['local-2']?.provider).toBe('ollama');
    expect(parsed.models['local-3']?.provider).toBe('ollama-2');
    expect(parsed.providers['ollama-2']).toMatchObject({ baseUrl: 'http://gpu:11434/v1' });
    expect(parsed.models['remote-2']).toMatchObject({ provider: 'deepseek', effort: 'high' });
    expect(parsed.models['remote-3']?.provider).toBe('anthropic');
    // Size aliases follow the preferred remote provider.
    expect(parsed.models.haiku?.provider).toBe('openai');
  });

  test('refuses an empty setup', () => {
    expect(() => buildSetupConfig({ locals: [], remotes: [], escalationPolicy: 'auto' })).toThrow();
  });
});

describe('writeConfigLayer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-setup-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('merges into an existing file, keeps unrelated keys, and backs it up', () => {
    const file = join(dir, '.harness', 'config.json');
    writeConfigLayer(file, { permissions: { bash: 'deny' } });
    const layer = buildSetupConfig({
      locals: [
        {
          providerId: 'lmstudio',
          baseUrl: 'http://localhost:1234/v1',
          model: 'm',
          contextWindow: 8192,
        },
      ],
      remotes: [],
      escalationPolicy: 'off',
    });
    const result = writeConfigLayer(file, layer);
    expect(result.backup && existsSync(result.backup)).toBe(true);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.permissions.bash).toBe('deny');
    expect(written.models.local.model).toBe('m');
    // The written project file loads cleanly through the normal path.
    const { config } = loadConfig(dir, { HARNESS_HOME: join(dir, 'home') });
    expect(config.routing.mode).toBe('local-only');
  });

  test('keeps the user’s comments and formatting', () => {
    const file = join(dir, 'config.json');
    const original = `{
  // my GPU box
  "providers": { "gpu": { "type": "openai-compatible", "baseUrl": "http://gpu:8000/v1" } },
  "models": { "local": { "provider": "gpu", "model": "old", "contextWindow": 32768 } }, // tuned
}
`;
    writeFileSync(file, original);
    const result = writeConfigLayer(file, {
      models: { local: { provider: 'gpu', model: 'new' } },
      routing: { escalation: { policy: 'ask' } },
    });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('// my GPU box');
    expect(text).toContain('// tuned');
    expect(parseJsonc(text)).toEqual(result.config);
    expect(result.config).toMatchObject({
      models: { local: { model: 'new', contextWindow: 32768 } },
      routing: { escalation: { policy: 'ask' } },
    });
  });

  test('refuses to write an invalid result', () => {
    const file = join(dir, 'config.json');
    writeFileSync(file, '{}');
    expect(() =>
      writeConfigLayer(file, { models: { local: { provider: 'ghost', model: 'x' } } }),
    ).toThrow('unknown provider "ghost"');
    expect(readFileSync(file, 'utf8')).toBe('{}');
    expect(() => writeConfigLayer(file, { routing: { mode: 'sideways' } })).toThrow(
      'invalid config',
    );
  });
});

describe('probeContextWindow', () => {
  test('identifies the server and reports where the number came from', async () => {
    const llama = fakeFetch({
      'http://gpu:8080/v1/models': { data: [{ id: 'default' }] },
      'http://gpu:8080/props': { default_generation_settings: { n_ctx: 16384 } },
    });
    expect(await probeContextWindow('http://gpu:8080/v1', 'default', { fetch: llama })).toEqual({
      contextWindow: 16384,
      source: 'llama.cpp /props n_ctx',
    });
    expect(
      await probeContextWindow('http://gpu:8080/v1', 'missing', { fetch: llama }),
    ).toBeUndefined();
  });
});
