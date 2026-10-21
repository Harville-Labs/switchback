import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonc } from '../config.ts';
import type { SetupFlags } from './flags.ts';
import { runSetup } from './flow.ts';
import { findOpenCodeConfigs, fromOpenCode } from './from-opencode.ts';
import type { SetupChoice, SetupPrompter } from './prompter.ts';

describe('translating an OpenCode config', () => {
  test('its models become setup answers, and its main model is current', () => {
    const got = fromOpenCode(
      {
        model: 'anthropic/claude-sonnet-5',
        small_model: 'opencode-go/kimi-k3',
        agent: { review: { model: 'openrouter/qwen/qwen3-coder' } },
        provider: {
          ollama: {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'http://localhost:11434/v1/' },
            models: { 'qwen3-coder:30b': { limit: { context: 65_536, output: 8_192 } } },
          },
          together: {
            options: { baseURL: 'https://api.together.xyz/v1', apiKey: '{env:TOGETHER_KEY}' },
            models: {
              'big-coder': {
                limit: { context: 131_072, output: 16_384 },
                cost: { input: 1, output: 2 },
              },
            },
          },
        },
      },
      {},
    );
    expect(got.locals).toEqual([
      {
        providerId: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen3-coder:30b',
        contextWindow: 65_536,
      },
    ]);
    expect(got.remotes).toEqual([
      { kind: 'anthropic', model: 'claude-sonnet-5' },
      { kind: 'opencode', plan: 'go', model: 'kimi-k3' },
      {
        kind: 'openrouter',
        model: 'qwen/qwen3-coder',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      },
      {
        kind: 'openai-compatible',
        model: 'big-coder',
        baseUrl: 'https://api.together.xyz/v1',
        apiKeyEnv: 'TOGETHER_KEY',
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        price: { input: 1, output: 2 },
      },
    ]);
    expect(got.current).toBe(got.remotes[0]);
    expect(got.agents?.review).toEqual({
      config: { description: 'The "review" agent from OpenCode.' },
      model: expect.objectContaining({ model: 'qwen/qwen3-coder' }),
    });
    expect(got.skipped).toEqual([]);
  });

  test("cloud providers keep their settings; what can't come over says why", () => {
    const got = fromOpenCode(
      {
        model: 'amazon-bedrock/us.anthropic.claude-opus-5',
        small_model: 'github-copilot/gpt-6-sol',
        disabled_providers: ['openai'],
        agent: {
          a: { model: 'openai/gpt-6-sol' },
          b: { model: 'google-vertex-anthropic/claude-sonnet-5@20260901' },
        },
        provider: {
          'amazon-bedrock': { options: { region: 'eu-west-1', profile: 'work' } },
          'google-vertex-anthropic': { options: { project: 'acme' } },
          lab: {
            npm: '@ai-sdk/anthropic',
            options: { baseURL: 'https://proxy.example.com', apiKey: 'sk-live-123' },
            models: { 'claude-x': {} },
          },
        },
      },
      {},
    );
    expect(got.remotes).toEqual([
      { kind: 'bedrock', model: 'claude-opus-5', region: 'eu-west-1', profile: 'work' },
      { kind: 'vertex', model: 'claude-sonnet-5', projectId: 'acme', region: 'global' },
    ]);
    // A key written into the config isn't copied; disabled providers are left out.
    expect(got.skipped).toEqual([
      expect.stringContaining('github-copilot/gpt-6-sol: Switchback has no "github-copilot"'),
      expect.stringContaining("lab's API key: OpenCode's config holds it"),
      expect.stringContaining('lab/claude-x: @ai-sdk/anthropic at a custom URL'),
      expect.stringContaining("agent a's model openai/gpt-6-sol: that model didn't come over"),
    ]);
  });

  test('MCP servers take Switchback’s shape', () => {
    const got = fromOpenCode({
      mcp: {
        files: {
          type: 'local',
          command: ['npx', '-y', 'files-mcp'],
          environment: { ROOT: '{env:HOME}' },
          enabled: false,
        },
        jira: {
          type: 'remote',
          url: 'https://jira.example.com/mcp',
          headers: { Authorization: 'Bearer {env:JIRA}' },
        },
        sso: { type: 'remote', url: 'https://sso.example.com/mcp', oauth: { clientId: 'x' } },
        'bad name': { type: 'local', command: ['x'] },
      },
    });
    expect(got.mcpServers).toEqual({
      files: {
        command: 'npx',
        args: ['-y', 'files-mcp'],
        env: { ROOT: '{env:HOME}' },
        enabled: false,
      },
      jira: {
        url: 'https://jira.example.com/mcp',
        headers: { Authorization: 'Bearer {env:JIRA}' },
      },
      sso: { url: 'https://sso.example.com/mcp' },
    });
    expect(got.skipped).toEqual([
      expect.stringContaining('"sso" signs in with OAuth'),
      expect.stringContaining('MCP server "bad name"'),
    ]);
  });

  test('permissions become levels and rules', () => {
    const got = fromOpenCode({
      permission: {
        '*': 'ask',
        shell: { '*': 'ask', 'git *': 'allow', 'git push *': 'deny' },
        edit: { '*': 'allow', '$HOME/notes/*.md': 'deny', '/etc/*': 'deny' },
        webfetch: { '*': 'ask', 'https://docs.example.com/*': 'allow' },
        websearch: 'deny',
        external_directory: { '~/projects/**': 'allow' },
        doom_loop: 'ask',
      },
    });
    expect(got.permissions).toEqual({
      levels: { read: 'ask', edit: 'allow', bash: 'ask', web: 'deny', mcp: 'ask' },
      allow: [
        'bash(git *)',
        'webfetch(domain:docs.example.com)',
        'read(~/projects/**)',
        'edit(~/projects/**)',
      ],
      ask: [],
      deny: ['bash(git push *)', 'edit(~/notes/*.md)', 'edit(//etc/*)'],
    });
    expect(got.skipped).toEqual([expect.stringContaining('permission for doom_loop')]);
  });

  test('one word for every permission, and the old tool switches', () => {
    expect(fromOpenCode({ permission: 'allow' }).permissions?.levels).toEqual({
      read: 'allow',
      edit: 'allow',
      bash: 'allow',
      web: 'allow',
      mcp: 'allow',
    });
    expect(fromOpenCode({ tools: { write: false, bash: false } }).permissions?.levels).toEqual({
      edit: 'deny',
      bash: 'deny',
    });
    expect(fromOpenCode({}).permissions).toBeUndefined();
  });
});

test('config files are found globally, by OPENCODE_CONFIG, and up to the git root', () => {
  const root = mkdtempSync(join(tmpdir(), 'sb-oc-'));
  const xdg = join(root, 'xdg');
  const repo = join(root, 'repo');
  const pkg = join(repo, 'packages', 'app');
  mkdirSync(join(xdg, 'opencode'), { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(pkg, { recursive: true });
  const files = [
    join(xdg, 'opencode', 'opencode.json'),
    join(root, 'custom.json'),
    join(repo, 'opencode.jsonc'),
    join(pkg, 'opencode.json'),
  ];
  for (const f of files) writeFileSync(f, '{}');
  // Above the git root: not this project's.
  writeFileSync(join(root, 'opencode.json'), '{}');
  expect(
    findOpenCodeConfigs(pkg, { HOME: root, XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG: files[1] }),
  ).toEqual(files);
});

describe('setup', () => {
  /** A Switchback home with nothing in it, and an OpenCode config beside it. */
  function machine(config: unknown) {
    const root = mkdtempSync(join(tmpdir(), 'sb-from-'));
    const xdg = join(root, 'xdg');
    mkdirSync(join(xdg, 'opencode'), { recursive: true });
    writeFileSync(join(xdg, 'opencode', 'opencode.json'), JSON.stringify(config));
    mkdirSync(join(root, 'ws', '.git'), { recursive: true });
    const env = { HOME: root, XDG_CONFIG_HOME: xdg, SWITCHBACK_HOME: join(root, 'sb') };
    const flags: SetupFlags = {
      cwd: join(root, 'ws'),
      yes: false,
      noLocal: false,
      localUrls: [],
      localModels: [],
      contextWindows: [],
      remotes: [],
      remoteModels: [],
    };
    const read = () =>
      parseJsonc(readFileSync(join(root, 'sb', 'config.json'), 'utf8')) as {
        models: object;
        routing: object;
        mcpServers: object;
        permissions: { allow: string[] };
        agents?: object;
        compaction?: object;
      };
    return { env, flags, read };
  }

  const opencode = {
    model: 'ollama/qwen3-coder:30b',
    provider: {
      ollama: {
        options: { baseURL: 'http://localhost:11434/v1' },
        models: { 'qwen3-coder:30b': { limit: { context: 65_536 } }, 'tiny:1b': {} },
      },
    },
    mcp: { files: { type: 'local', command: ['files-mcp'] } },
    permission: { shell: { 'make *': 'allow' } },
    agent: { quick: { description: 'Small fixes', model: 'ollama/tiny:1b' } },
    compaction: { auto: false },
  };

  /** Answers questions in order; any other question fails the test. */
  function answers(steps: [string, unknown][]): SetupPrompter {
    const next = (q: string) => {
      const step = steps.shift();
      if (!step || !q.includes(step[0])) throw new Error(`unexpected question: ${q}`);
      return step[1];
    };
    return {
      text: async (q) => next(q) as string,
      number: async (q) => next(q) as number | undefined,
      confirm: async (q) => next(q) as boolean,
      select: async <T>(q: string, options: SetupChoice<T>[]) => {
        const want = next(q);
        const hit = options.find((o) => o.value === want);
        if (!hit) throw new Error(`${q}: no option ${String(want)}`);
        return hit.value;
      },
      multiSelect: async (q) => next(q) as never,
      search: async (q) => next(q) as string,
      note: () => {},
    };
  }

  test('a first run offers to start from OpenCode, first of all', async () => {
    const m = machine(opencode);
    const ui = answers([
      ['Coming from another coding agent?', 'opencode'],
      ['Add other models too?', false],
      ['Which model does what', 'done'],
    ]);
    const result = await runSetup(m.flags, ui, { env: m.env });
    expect(result.outcome).toBe('written');
    const cfg = m.read();
    expect(cfg.models).toEqual({
      'qwen3-coder-30b': { provider: 'ollama', model: 'qwen3-coder:30b', contextWindow: 65_536 },
      'tiny-1b': { provider: 'ollama', model: 'tiny:1b' },
    });
    expect(cfg.routing).toMatchObject({ current: ['qwen3-coder-30b'], escalate: [['tiny-1b']] });
    expect(cfg.mcpServers).toEqual({ files: { command: 'files-mcp' } });
    // An agent's model is written as the alias setup gave it.
    expect(cfg.agents).toEqual({ quick: { description: 'Small fixes', model: 'tiny-1b' } });
    expect(cfg.compaction).toEqual({ enabled: false });
    // Its rules are added to the ones every new config starts with.
    expect(cfg.permissions.allow).toContain('bash(make *)');
    expect(cfg.permissions.allow).toContain('bash(git status:*)');
  });

  test('starting fresh asks the usual questions', async () => {
    const m = machine(opencode);
    const ui = answers([
      ['Coming from another coding agent?', ''],
      ['Do you have any local model endpoints?', false],
      ['Set up any remote providers?', false],
    ]);
    const detect = async () => [];
    expect((await runSetup(m.flags, ui, { env: m.env, detect })).outcome).toBe('nothing');
  });

  test('unattended with --from opencode', async () => {
    const m = machine(opencode);
    await runSetup({ ...m.flags, yes: true, from: 'opencode' }, undefined, { env: m.env });
    expect(Object.keys(m.read().models)).toEqual(['qwen3-coder-30b', 'tiny-1b']);
  });
});

test("the model it started with isn't also a step up from itself", async () => {
  const root = mkdtempSync(join(tmpdir(), 'sb-from-'));
  mkdirSync(join(root, 'xdg', 'opencode'), { recursive: true });
  writeFileSync(
    join(root, 'xdg', 'opencode', 'opencode.json'),
    JSON.stringify({
      model: 'anthropic/claude-sonnet-5',
      provider: {
        ollama: { options: { baseURL: 'http://localhost:11434/v1' }, models: { 'qwen3:8b': {} } },
      },
    }),
  );
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'xdg'), SWITCHBACK_HOME: join(root, 'sb') };
  await runSetup(
    {
      cwd: root,
      yes: true,
      from: 'opencode',
      noLocal: false,
      localUrls: [],
      localModels: [],
      contextWindows: [],
      remotes: [],
      remoteModels: [],
    },
    undefined,
    { env },
  );
  const cfg = parseJsonc(readFileSync(join(root, 'sb', 'config.json'), 'utf8')) as {
    routing: { current: string[]; escalate: string[][] };
  };
  expect(cfg.routing.current).toEqual(['claude-sonnet-5']);
  expect(cfg.routing.escalate).toEqual([['qwen3-8b']]);
});
