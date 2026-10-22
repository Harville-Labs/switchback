import { describe, expect, test } from 'bun:test';
import type { DetectedServer } from '@switchback/providers';
import type { SetupFlags } from './flags.ts';
import { chooseLocals } from './local.ts';
import type { SetupChoice as Option, SetupPrompter as Prompter } from './prompter.ts';
import { chooseRemotes } from './remote.ts';
import { chooseRoles } from './roles.ts';

/** One expected question and the answer to give: `default` takes the prompt's default. */
type Step = [question: string, answer: unknown];

/**
 * Answers setup's questions in order, failing on any it didn't expect, and
 * records each question's default so tests can check what's offered.
 */
function scripted(steps: Step[]) {
  const queue = [...steps];
  const defaults: Record<string, unknown> = {};
  /** The values each list offered, by expected question. */
  const offered: Record<string, unknown[]> = {};
  /** Questions whose answers weren't shown as typed. */
  const secret: string[] = [];
  const said: string[] = [];
  const next = (question: string, fallback?: unknown, options?: Option<unknown>[]) => {
    const step = queue.shift();
    if (!step) throw new Error(`unexpected question: ${question}`);
    const [expected, answer] = step;
    if (!question.includes(expected)) throw new Error(`expected "${expected}", got "${question}"`);
    defaults[expected] = fallback;
    if (options) offered[expected] = options.map((o) => o.value);
    return answer === 'default' ? fallback : answer;
  };
  const p = {
    text: async (q: string, fallback?: string, opts?: { secret?: boolean }) => {
      if (opts?.secret) secret.push(q);
      return next(q, fallback);
    },
    number: async (q: string, fallback?: number) => next(q, fallback),
    confirm: async (q: string, fallback = true) => next(q, fallback),
    select: async <T>(q: string, options: Option<T>[], i = 0) =>
      next(q, options[i]?.value, options),
    search: async (q: string, options: Option<string>[]) => next(q, undefined, options),
    // Answers name the labels to tick.
    multiSelect: async <T>(q: string, options: Option<T>[]) => {
      const labels = next(q) as string[];
      return options.filter((o) => labels.includes(o.label)).map((o) => o.value);
    },
    note: (n: { kind: string; text?: string }) => {
      if (n.text) said.push(n.text);
    },
  } as unknown as Prompter;
  return { p, defaults, offered, secret, said, left: () => queue.map(([q]) => q) };
}

const flags: SetupFlags = {
  cwd: '/tmp',
  yes: false,
  noLocal: false,
  localUrls: [],
  localModels: [],
  contextWindows: [],
  remotes: [],
  remoteModels: [],
};

const ollama: DetectedServer = {
  kind: 'ollama',
  label: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  models: [
    { id: 'llama-chat', contextWindow: 8_192 },
    { id: 'qwen3-coder:30b', contextWindow: 32_768, tools: true },
  ],
};
const gpu: DetectedServer = {
  kind: 'openai-compatible',
  label: 'gpu-box:8000',
  baseUrl: 'http://gpu-box:8000/v1',
  models: [{ id: 'big-coder' }],
};

/** Detection that finds Ollama on this machine, and the GPU box only when asked for it. */
const detect = async ({ extra = [] }: { extra?: string[] } = {}) => [
  ollama,
  ...(extra.includes(gpu.baseUrl) ? [gpu] : []),
];

describe('local endpoints', () => {
  test('one endpoint at a time, each with a checklist of its models', async () => {
    const s = scripted([
      ['Do you have any local model endpoints?', 'default'],
      ['Endpoint URL', 'default'],
      ['Which models from Ollama?', ['qwen3-coder:30b', 'llama-chat']],
      ['Any more local endpoints?', true],
      ['Endpoint URL', 'http://gpu-box:8000'],
      ['Which models from gpu-box:8000?', ['big-coder']],
      // The server didn't say, so it's the one question asked per model.
      ['Context window (tokens) for big-coder', 131_072],
      ['Any more local endpoints?', false],
    ]);
    const locals = await chooseLocals(flags, s.p, detect);
    expect(s.left()).toEqual([]);
    // What was found is offered: yes, and its URL.
    expect(s.defaults['Do you have any local model endpoints?']).toBe(true);
    expect(s.defaults['Endpoint URL']).toBe('http://localhost:11434/v1');
    expect(locals).toEqual([
      // Tool-capable models are listed first.
      {
        providerId: 'ollama',
        baseUrl: ollama.baseUrl,
        model: 'qwen3-coder:30b',
        contextWindow: 32_768,
      },
      { providerId: 'ollama', baseUrl: ollama.baseUrl, model: 'llama-chat', contextWindow: 8_192 },
      {
        providerId: 'local-server',
        baseUrl: gpu.baseUrl,
        model: 'big-coder',
        contextWindow: 131_072,
      },
    ]);
  });

  test('"no" skips local models, and is the default when nothing was found', async () => {
    const s = scripted([['Do you have any local model endpoints?', 'default']]);
    expect(await chooseLocals(flags, s.p, async () => [])).toEqual([]);
    expect(s.defaults['Do you have any local model endpoints?']).toBe(false);
  });

  test('an endpoint that lists no models takes one by hand', async () => {
    const s = scripted([
      ['Do you have any local model endpoints?', true],
      ['Endpoint URL', 'http://10.0.0.5:9000/'],
      ['Model name', 'house-model'],
      ['Context window', 16_384],
      ['Environment variable holding an API key', 'HOUSE_KEY'],
      ['Any more local endpoints?', false],
    ]);
    expect(await chooseLocals(flags, s.p, async () => [])).toEqual([
      {
        providerId: 'local-server',
        baseUrl: 'http://10.0.0.5:9000/v1',
        model: 'house-model',
        contextWindow: 16_384,
        apiKeyEnv: 'HOUSE_KEY',
      },
    ]);
  });
});

describe('remote providers', () => {
  test('a provider at a time, each with its own setup, until there are no more', async () => {
    const s = scripted([
      ['Set up any remote providers?', true],
      ['Which provider?', 'deepseek'],
      ['Which model?', 'deepseek-flash'],
      ['Any additional remote providers?', true],
      ['Which provider?', 'deepseek'],
      ['Which model?', 'deepseek-v4-pro'],
      ['Any additional remote providers?', false],
    ]);
    expect(await chooseRemotes(flags, s.p, false, undefined, { DEEPSEEK_API_KEY: 'k' })).toEqual([
      { kind: 'deepseek', model: 'deepseek-flash' },
      { kind: 'deepseek', model: 'deepseek-v4-pro' },
    ]);
    expect(s.defaults['Set up any remote providers?']).toBe(false);
  });

  test('"no" skips them; with no local models, yes is the default', async () => {
    const none = scripted([['Set up any remote providers?', false]]);
    expect(await chooseRemotes(flags, none.p, true)).toEqual([]);
    expect(none.defaults['Set up any remote providers?']).toBe(true);
  });

  test('OpenCode: the plan, then a model from its live list, without Gemini', async () => {
    const asked: string[] = [];
    const list = async (url: string) => {
      asked.push(url);
      return [{ id: 'kimi-k3' }, { id: 'gemini-3-pro' }, { id: 'glm-5.3' }];
    };
    const s = scripted([
      ['Set up any remote providers?', true],
      ['Which provider?', 'opencode'],
      ['Which OpenCode plan?', 'go'],
      ['Which model?', 'glm-5.3'],
      ['Context window', 'default'],
      ['Any additional remote providers?', false],
    ]);
    expect(await chooseRemotes(flags, s.p, true, list as never, { OPENCODE_API_KEY: 'k' })).toEqual(
      [{ kind: 'opencode', plan: 'go', model: 'glm-5.3', contextWindow: 128_000 }],
    );
    expect(asked).toEqual(['https://opencode.ai/zen/go/v1']);
    expect(s.offered['Which model?']).toEqual(['kimi-k3', 'glm-5.3']);
  });
});

describe('API keys', () => {
  const pick = (kind: string): Step[] => [
    ['Set up any remote providers?', true],
    ['Which provider?', kind],
  ];
  const done: Step = ['Any additional remote providers?', false];

  test('every provider that signs in with a key asks for one when none is set', async () => {
    const cases: [string, Step[]][] = [
      ['anthropic', [['Which model?', 'default']]],
      ['openai', [['Which model?', 'default']]],
      ['deepseek', [['Which model?', 'default']]],
      ['gemini', [['Which model?', 'default']]],
      [
        'foundry',
        [
          ['Which model?', 'default'],
          ['Foundry resource name', 'res'],
        ],
      ],
      [
        'azure-openai',
        [
          ['Which model?', 'default'],
          ['Azure OpenAI resource name', 'res'],
          ['Deployment name', 'default'],
          ['Sign in with', 'key'],
        ],
      ],
      [
        'opencode',
        [
          ['Which OpenCode plan?', 'zen'],
          ['Model ID', 'glm-5.3'],
          ['Context window', 'default'],
        ],
      ],
      [
        'openrouter',
        [
          ['Model ID', 'x/y'],
          ['Context window', 'default'],
        ],
      ],
    ];
    for (const [kind, steps] of cases) {
      const key: Step = ['API key for', `key-${kind}`];
      // OpenRouter asks before listing, so the key can list its models.
      const order =
        kind === 'openrouter' ? [...pick(kind), key, ...steps] : [...pick(kind), ...steps, key];
      const s = scripted([...order, done]);
      const [answer] = await chooseRemotes(flags, s.p, true, async () => [], {});
      expect(answer).toMatchObject({ kind, apiKey: `key-${kind}` });
      expect(s.secret).toHaveLength(1);
      expect(s.left()).toEqual([]);
    }
  });

  test('a key found in the environment is not asked for', async () => {
    const s = scripted([...pick('anthropic'), ['Which model?', 'default'], done]);
    const [answer] = await chooseRemotes(flags, s.p, true, undefined, { ANTHROPIC_API_KEY: 'k' });
    expect(answer).not.toHaveProperty('apiKey');
  });

  test('an empty answer leaves the key to the environment, with a warning', async () => {
    const s = scripted([...pick('deepseek'), ['Which model?', 'default'], ['API key', ''], done]);
    const [answer] = await chooseRemotes(flags, s.p, true, undefined, {});
    expect(answer).not.toHaveProperty('apiKey');
    expect(s.said.join('\n')).toContain('set DEEPSEEK_API_KEY');
  });

  test('Azure OpenAI with Entra ID needs no key', async () => {
    const s = scripted([
      ...pick('azure-openai'),
      ['Which model?', 'default'],
      ['Azure OpenAI resource name', 'res'],
      ['Deployment name', 'default'],
      ['Sign in with', 'entra'],
      done,
    ]);
    const [answer] = await chooseRemotes(flags, s.p, true, undefined, {});
    expect(answer).toMatchObject({ auth: 'entra' });
    expect(s.secret).toEqual([]);
  });

  test('OpenRouter lists its models with the pasted key', async () => {
    const keys: (string | undefined)[] = [];
    const list = async (_url: string, opts?: { apiKey?: string }) => {
      keys.push(opts?.apiKey);
      return [{ id: 'x/y', contextWindow: 1000 }];
    };
    const s = scripted([
      ...pick('openrouter'),
      ['API key', 'or-key'],
      ['Which model?', 'x/y'],
      done,
    ]);
    await chooseRemotes(flags, s.p, true, list as never, {});
    expect(keys).toEqual(['or-key']);
  });

  test('an OpenAI-compatible server without a key variable may take a key or none', async () => {
    const s = scripted([
      ...pick('openai-compatible'),
      ['API base URL', 'http://gateway.test/v1'],
      ['Environment variable', ''],
      ['API key for OpenAI-compatible API (leave empty if it needs none)', ''],
      ['Model ID', 'm'],
      ['Context window', 'default'],
      done,
    ]);
    const [answer] = await chooseRemotes(flags, s.p, true, async () => [], {});
    expect(answer).not.toHaveProperty('apiKey');
    expect(s.said.join('\n')).not.toContain('needs an API key');
  });

  test('a project config never gets a key, since it may be committed', async () => {
    const s = scripted([...pick('openai'), ['Which model?', 'default'], done]);
    const [answer] = await chooseRemotes({ ...flags, scope: 'project' }, s.p, true, undefined, {});
    expect(answer).not.toHaveProperty('apiKey');
    expect(s.said.join('\n')).toContain('set OPENAI_API_KEY');
  });

  test('unattended setup warns instead of asking', async () => {
    const answers = await chooseRemotes(
      { ...flags, remotes: ['gemini'] },
      undefined,
      true,
      undefined,
      {},
    );
    expect(answers).toEqual([{ kind: 'gemini', model: expect.any(String) }]);
  });
});

describe('subscriptions', () => {
  test("Claude Code and Codex take the plan's models without asking which", async () => {
    for (const kind of ['claude-code', 'codex']) {
      const s = scripted([
        ['Set up any remote providers?', true],
        ['Which provider?', kind],
        ['Any additional', false],
      ]);
      const answers = await chooseRemotes(flags, s.p, true, undefined, {});
      expect(answers.length).toBeGreaterThan(1);
      expect(answers.every((a) => a.kind === kind && !('apiKey' in a))).toBe(true);
    }
  });

  test('--remote-model still picks one', async () => {
    const answers = await chooseRemotes(
      { ...flags, remotes: ['codex'], remoteModels: ['gpt-6-sol'] },
      undefined,
      true,
      undefined,
      {},
    );
    expect(answers).toEqual([{ kind: 'codex', model: 'gpt-6-sol' }]);
  });
});

describe('which model does what', () => {
  const coder = {
    alias: 'coder',
    tier: 'local',
    model: 'qwen3-coder:30b',
    where: 'ollama',
  } as const;
  const sol = { alias: 'sol', tier: 'remote', model: 'gpt-6-sol', where: 'openai' } as const;

  test('one model does everything, so nothing is asked', async () => {
    const s = scripted([]);
    const roles = await chooseRoles(flags, s.p, [coder]);
    expect(roles).toMatchObject({ current: ['coder'], escalate: [], review: 'off' });
    expect(s.said).toContain('Which model does what');
  });

  test('with two models, the ladder can be changed', async () => {
    const s = scripted([
      ['Which model does what', 'escalate'],
      ['When a turn is too hard for coder, hand it to:', ''],
      ['Which model does what', 'done'],
    ]);
    const roles = await chooseRoles(flags, s.p, [coder, sol]);
    expect(roles.escalate).toEqual([]);
    expect(s.left()).toEqual([]);
  });
});
