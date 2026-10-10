import { describe, expect, test } from 'bun:test';
import type { DetectedServer } from '@switchback/providers';
import type { SetupFlags } from './flags.ts';
import { chooseLocals } from './local.ts';
import type { SetupChoice as Option, SetupPrompter as Prompter } from './prompter.ts';
import { chooseRemotes } from './remote.ts';

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
    text: async (q: string, fallback?: string) => next(q, fallback),
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
    note: () => {},
  } as unknown as Prompter;
  return { p, defaults, offered, left: () => queue.map(([q]) => q) };
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
    expect(await chooseRemotes(flags, s.p, false)).toEqual([
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
    expect(await chooseRemotes(flags, s.p, true, list as never)).toEqual([
      { kind: 'opencode', plan: 'go', model: 'glm-5.3', contextWindow: 128_000 },
    ]);
    expect(asked).toEqual(['https://opencode.ai/zen/go/v1']);
    expect(s.offered['Which model?']).toEqual(['kimi-k3', 'glm-5.3']);
  });
});
