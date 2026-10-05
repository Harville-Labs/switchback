import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeContextWindow } from '@switchback/providers';
import { loadConfig, parseJsonc, referenceProblem, SwitchbackConfig } from './config.ts';
import {
  buildSetupConfig,
  defaultRoles,
  detectLocalServers,
  OLLAMA_DEFAULT_CONTEXT,
  planModels,
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

  test('aliases come from model names; local + Bedrock uses prefixed IDs', () => {
    const layer = buildSetupConfig({
      locals: [local],
      remotes: [{ kind: 'bedrock', model: 'claude-sonnet-5', region: 'us-west-2' }],
      escalationPolicy: 'ask',
      budget: { dailyUsd: 3 },
    });
    const parsed = SwitchbackConfig.parse(layer);
    expect(parsed.models['coder-7b']).toMatchObject({ provider: 'ollama', model: 'coder:7b' });
    expect(parsed.models['claude-sonnet-5']).toMatchObject({
      provider: 'bedrock',
      model: 'anthropic.claude-sonnet-5',
    });
    // Claude Code size aliases follow the first hosted provider.
    expect(parsed.models.haiku?.model).toBe('anthropic.claude-haiku-4-5');
    expect(parsed.routing).toMatchObject({
      start: ['coder-7b'],
      escalate: [['claude-sonnet-5']],
      budget: { dailyUsd: 3 },
      escalation: { policy: 'ask' },
    });
    expect(parsed.review.mode).toBe('off');
    expect(parsed.providers.ollama).toMatchObject({ type: 'openai-compatible', tier: 'local' });
  });

  test('every hosted provider gets the same treatment', () => {
    for (const [kind, model] of [
      ['anthropic', 'claude-sonnet-5'],
      ['openai', 'gpt-6-sol'],
      ['deepseek', 'deepseek-flash'],
      ['gemini', 'gemini-3.8-flash'],
    ] as const) {
      const parsed = SwitchbackConfig.parse(
        buildSetupConfig({ locals: [local], remotes: [{ kind, model }], escalationPolicy: 'auto' }),
      );
      expect(parsed.providers[kind]?.type).toBe(kind);
      expect(parsed.models[model]).toMatchObject({ provider: kind, model });
      for (const alias of ['opus', 'sonnet', 'haiku'])
        expect(parsed.models[alias]?.provider).toBe(kind);
    }
  });

  test('Claude Platform on AWS and Foundry use bare Claude IDs and the Claude catalog', () => {
    const parsed = SwitchbackConfig.parse(
      buildSetupConfig({
        locals: [],
        remotes: [
          {
            kind: 'anthropic-aws',
            model: 'claude-opus-5',
            region: 'us-west-2',
            workspaceId: 'wrkspc_1',
          },
          { kind: 'foundry', model: 'claude-sonnet-5', resource: 'acme' },
        ],
        escalationPolicy: 'auto',
      }),
    );
    expect(parsed.providers['anthropic-aws']).toMatchObject({
      type: 'anthropic-aws',
      workspaceId: 'wrkspc_1',
    });
    expect(parsed.providers.foundry).toMatchObject({ type: 'foundry', resource: 'acme' });
    expect(parsed.models['claude-opus-5']?.provider).toBe('anthropic-aws');
    expect(parsed.models['claude-sonnet-5']?.provider).toBe('foundry');
    expect(parsed.models.haiku?.model).toBe('claude-haiku-4-5');
  });

  test('DeepSeek models get an effort so thinking mode is on', () => {
    const layer = buildSetupConfig({
      locals: [],
      remotes: [{ kind: 'deepseek', model: 'deepseek-v4-pro' }],
      escalationPolicy: 'auto',
    });
    expect((layer.models as Record<string, { effort?: string }>)['deepseek-v4-pro']?.effort).toBe(
      'high',
    );
  });

  test('any OpenAI-compatible API can serve hosted models', () => {
    const parsed = SwitchbackConfig.parse(
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
    expect(parsed.providers.openrouter).toMatchObject({
      type: 'openai-compatible',
      tier: 'remote',
      apiKey: '{env:OPENROUTER_API_KEY}',
    });
    expect(parsed.models['qwen3-coder']).toMatchObject({
      provider: 'openrouter',
      model: 'qwen/qwen3-coder',
      contextWindow: 262144,
    });
  });

  test("Azure OpenAI: requests name the deployment, with the catalog model's limits and price", () => {
    const parsed = SwitchbackConfig.parse(
      buildSetupConfig({
        locals: [],
        remotes: [
          { kind: 'azure-openai', model: 'gpt-6-sol', deployment: 'prod-gpt', resource: 'acme' },
        ],
        escalationPolicy: 'auto',
      }),
    );
    expect(parsed.providers['azure-openai']).toMatchObject({
      type: 'azure-openai',
      resource: 'acme',
      api: 'responses',
    });
    const m = parsed.models['gpt-6-sol'];
    expect(m).toMatchObject({ provider: 'azure-openai', model: 'prod-gpt' });
    expect(m?.price?.input).toBeGreaterThan(0);
    expect(m?.contextWindow).toBeGreaterThan(0);
    // No size aliases: they'd name deployments nobody created.
    expect(parsed.models.opus).toBeUndefined();
  });

  test('OpenRouter: what its model list says is written out', () => {
    const parsed = SwitchbackConfig.parse(
      buildSetupConfig({
        locals: [],
        remotes: [
          {
            kind: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'qwen/qwen3-coder',
            apiKeyEnv: 'OPENROUTER_API_KEY',
            contextWindow: 262144,
            maxOutputTokens: 65536,
            price: { input: 0.4, output: 1.6 },
          },
        ],
        escalationPolicy: 'auto',
      }),
    );
    expect(parsed.providers.openrouter).toMatchObject({
      type: 'openai-compatible',
      tier: 'remote',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(parsed.models['qwen3-coder']).toMatchObject({
      contextWindow: 262144,
      maxOutputTokens: 65536,
      price: { input: 0.4, output: 1.6 },
    });
    expect(
      planModels({
        locals: [],
        remotes: [
          {
            kind: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'x/y',
            price: { input: 2, output: 3 },
          },
        ],
      })[0],
    ).toMatchObject({ where: 'OpenRouter', inputPrice: 2 });
  });

  test('Azure OpenAI with Entra ID, and Jev as the classifier', () => {
    const parsed = SwitchbackConfig.parse(
      buildSetupConfig({
        locals: [local],
        remotes: [
          {
            kind: 'azure-openai',
            model: 'gpt-6-sol',
            deployment: 'gpt-6-sol',
            resource: 'acme',
            auth: 'entra',
          },
        ],
        escalationPolicy: 'auto',
        classifier: 'jev',
      }),
    );
    expect(parsed.providers['azure-openai']).toMatchObject({ auth: 'entra' });
    expect(parsed.providers.typesafe).toMatchObject({ type: 'typesafe', tier: 'remote' });
    expect(parsed.models.jev).toEqual(
      expect.objectContaining({ provider: 'typesafe', model: 'jev-latest' }),
    );
    expect(parsed.routing.classifier?.model).toBe('jev');
    expect(referenceProblem(parsed)).toBeUndefined();
    // A chosen model can classify too; anything else is refused.
    const local2 = buildSetupConfig({
      locals: [local],
      remotes: [{ kind: 'openai', model: 'gpt-6-sol' }],
      escalationPolicy: 'auto',
      classifier: 'coder-7b',
    });
    expect((local2.routing as { classifier: unknown }).classifier).toEqual({ model: 'coder-7b' });
    expect(() =>
      buildSetupConfig({ locals: [local], remotes: [], escalationPolicy: 'auto', classifier: 'x' }),
    ).toThrow('classifier names "x"');
  });

  test('a decision model can only be the classifier', () => {
    const config = SwitchbackConfig.parse({
      providers: { typesafe: { type: 'typesafe' } },
      models: { jev: { provider: 'typesafe', model: 'jev-latest' } },
      routing: { start: ['jev'] },
    });
    expect(referenceProblem(config)).toBe(
      'routing.start[0]: "jev" is a decision model (typesafe), which can only be routing.classifier.model',
    );
  });

  test('azure-openai without a resource or URL is a config error', () => {
    expect(
      referenceProblem(SwitchbackConfig.parse({ providers: { az: { type: 'azure-openai' } } })),
    ).toContain('providers.az needs "resource"');
  });

  test('default roles: first local starts, other locals next, hosted cheapest first', () => {
    const plan = planModels({
      locals: [local, { ...local, baseUrl: 'http://gpu:8000/v1', model: 'big' }],
      remotes: [
        { kind: 'openai', model: 'gpt-6-sol' },
        { kind: 'anthropic', model: 'claude-opus-5' },
        { kind: 'deepseek', model: 'deepseek-v4-pro' },
      ],
    });
    expect(defaultRoles(plan)).toEqual({
      start: ['coder-7b'],
      escalate: [['big'], ['deepseek-v4-pro'], ['gpt-6-sol'], ['claude-opus-5']],
      review: 'off',
    });
    // All hosted: the cheapest starts.
    const hosted = defaultRoles(
      planModels({
        locals: [],
        remotes: [
          { kind: 'anthropic', model: 'claude-opus-5' },
          { kind: 'anthropic', model: 'claude-haiku-4-5' },
        ],
      }),
    );
    expect(hosted).toMatchObject({ start: ['claude-haiku-4-5'], escalate: [['claude-opus-5']] });
  });

  test('roles are written as chosen: any model anywhere, a review ladder, a subagent model', () => {
    const parsed = SwitchbackConfig.parse(
      buildSetupConfig({
        locals: [local, { ...local, model: 'big' }],
        remotes: [
          { kind: 'anthropic', model: 'claude-haiku-4-5' },
          { kind: 'anthropic', model: 'claude-opus-5' },
        ],
        roles: {
          start: ['claude-haiku-4-5', 'coder-7b'],
          escalate: [['big'], ['claude-opus-5']],
          review: [['big'], ['claude-opus-5']],
          subagents: 'coder-7b',
        },
        escalationPolicy: 'auto',
      }),
    );
    expect(parsed.routing).toMatchObject({
      start: ['claude-haiku-4-5', 'coder-7b'],
      escalate: [['big'], ['claude-opus-5']],
    });
    expect(parsed.review).toMatchObject({ mode: 'auto', models: [['big'], ['claude-opus-5']] });
    expect(parsed.subagents.model).toBe('coder-7b');
    // Two Anthropic models share one provider entry.
    expect(Object.keys(parsed.providers).filter((id) => id.startsWith('anthropic'))).toEqual([
      'anthropic',
    ]);
    expect(referenceProblem(parsed)).toBeUndefined();
  });

  test('review: the escalation ladder is written as an empty list', () => {
    const layer = buildSetupConfig({
      locals: [local],
      remotes: [{ kind: 'openai', model: 'gpt-6-sol' }],
      roles: { start: ['coder-7b'], escalate: [['gpt-6-sol']], review: 'ladder' },
      escalationPolicy: 'auto',
    });
    expect(layer.review).toEqual({ mode: 'auto', models: [] });
  });

  test('roles must name chosen models', () => {
    expect(() =>
      buildSetupConfig({
        locals: [local],
        remotes: [],
        roles: { start: ['ghost'], escalate: [], review: 'off' },
        escalationPolicy: 'auto',
      }),
    ).toThrow('start names "ghost"');
  });

  test('several local servers: one provider per server; same-named models get distinct aliases', () => {
    const parsed = SwitchbackConfig.parse(
      buildSetupConfig({
        locals: [
          local,
          { ...local, model: 'coder:32b', contextWindow: 65536 }, // same server, bigger model
          { providerId: 'ollama', baseUrl: 'http://gpu:11434/v1', model: 'coder:7b' },
        ],
        remotes: [],
        escalationPolicy: 'auto',
      }),
    );
    expect(Object.keys(parsed.models)).toEqual(['coder-7b', 'coder-32b', 'coder-7b-2']);
    expect(parsed.models['coder-32b']?.provider).toBe('ollama');
    expect(parsed.models['coder-7b-2']?.provider).toBe('ollama-2');
    expect(parsed.providers['ollama-2']).toMatchObject({ baseUrl: 'http://gpu:11434/v1' });
  });

  test('refuses an empty setup', () => {
    expect(() => buildSetupConfig({ locals: [], remotes: [], escalationPolicy: 'auto' })).toThrow();
  });
});

describe('writeConfigLayer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switchback-setup-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('merges into an existing file, keeps unrelated keys, and backs it up', () => {
    const file = join(dir, '.switchback', 'config.json');
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
    expect(written.models.m.model).toBe('m');
    // The written project file loads cleanly through the normal path.
    const { config } = loadConfig(dir, { SWITCHBACK_HOME: join(dir, 'home') });
    expect(config.routing).toMatchObject({ start: ['m'], escalate: [] });
  });

  test('re-running setup on an old file replaces the removed routing keys', () => {
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      `{
  // keep me
  "routing": { "local": ["old"], "remote": ["older"], "mode": "auto", "budget": { "dailyUsd": 2 } }
}
`,
    );
    writeConfigLayer(file, {
      providers: { lp: { type: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' } },
      models: { local: { provider: 'lp', model: 'm' } },
      routing: { start: ['local'], escalate: [] },
    });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('// keep me');
    expect(text).not.toContain('"mode"');
    expect((parseJsonc(text) as { routing: unknown }).routing).toMatchObject({
      start: ['local'],
      budget: { dailyUsd: 2 },
    });
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
    expect(() => writeConfigLayer(file, { routing: { fallback: 'sideways' } })).toThrow(
      'invalid config',
    );
  });
});

describe('probeContextWindow', () => {
  test('TGI and KoboldCpp report their limits on their own endpoints', async () => {
    const tgi = fakeFetch({
      'http://box:8080/v1/models': { data: [{ id: 'tgi' }] },
      'http://box:8080/info': { model_id: 'org/model', max_total_tokens: 32768 },
    });
    expect(await probeContextWindow('http://box:8080/v1', 'tgi', { fetch: tgi })).toEqual({
      contextWindow: 32768,
      source: 'TGI /info max_total_tokens',
    });
    const kobold = fakeFetch({
      'http://box:5001/v1/models': { data: [{ id: 'koboldcpp/model' }] },
      'http://box:5001/api/extra/true_max_context_length': { value: 12288 },
    });
    expect(
      await probeContextWindow('http://box:5001/v1', 'koboldcpp/model', { fetch: kobold }),
    ).toEqual({ contextWindow: 12288, source: 'KoboldCpp true_max_context_length' });
  });

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

test('writing a section migrates every removed key in it, review.model included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'switchback-migrate-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      '{ "review": { "mode": "auto", "model": "big" }, "routing": { "mode": "auto" } }',
    );
    writeConfigLayer(file, {
      providers: { lp: { type: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' } },
      models: { m: { provider: 'lp', model: 'm' } },
      routing: { start: ['m'], escalate: [] },
      review: { mode: 'off', models: [] },
    });
    const written = parseJsonc(readFileSync(file, 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(written.review).toEqual({ mode: 'off', models: [] });
    expect(written.routing).not.toHaveProperty('mode');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
