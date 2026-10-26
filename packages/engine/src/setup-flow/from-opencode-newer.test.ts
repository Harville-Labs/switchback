import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromOpenCode, readOpenCode } from './from-opencode.ts';

// OpenCode's newer format, as people write it: comments, trailing commas,
// `providers` with `package` and `settings`, `modelID`, a `permissions` list,
// and `mcp.servers`.
const CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "vllm-direct/big",
  "plugins": ["-opencode.provider.vllm"],
  "formatter": true,
  "providers": {
    "vllm": {
      "name": "Remote vLLM",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://vllm.example.com/v1", "timeout": false },
      "models": {
        "big": {
          "modelID": "acme/Big-1.5-FP8",
          // the model card's coding settings
          "body": { "temperature": 0.6, "top_p": 0.95, "top_k": 20, "min_p": 0 },
          "capabilities": { "tools": true, "input": ["text", "image"] },
          "compatibility": { "reasoningField": "reasoning_content" },
          "limit": { "context": 262144, "output": 32768 },
        },
        "lil": {
          "modelID": "lil",
          "limit": { "context": 65536, "output": 16384 },
          "variants": [{ "id": "direct", "body": { "chat_template_kwargs": { "enable_thinking": false } } }]
        }
      }
    },
    "vllm-direct": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://10.0.0.5:8000/v1" },
      "models": { "big": { "modelID": "acme/Big-1.5-FP8", "limit": { "context": 262144 } } }
    },
  },
  "agents": {
    "build": { "model": "vllm-direct/big", "steps": 60 },
    "explore": { "model": "vllm/lil#direct", "steps": 15 },
    "plan": { "model": "vllm/lil#none" },
    "title": { "model": "vllm/lil#direct" },
    "reviewer": {
      "description": "Reviews diffs",
      "mode": "subagent",
      "prompt": "Review the change.",
      "permissions": [
        { "action": "edit", "resource": "*", "effect": "deny" },
        { "action": "shell", "resource": "git diff *", "effect": "allow" },
      ],
    },
    "pls": { "tools": { "webfetch": false }, "temperature": 0.2 },
  },
  "compaction": { "auto": true, "keep": { "tokens": 26214 }, "buffer": 52429 },
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "allow" },
    { "action": "shell", "resource": "git push *", "effect": "ask" },
    { "action": "shell", "resource": "git reset --hard *", "effect": "deny" },
    { "action": "edit", "resource": "*", "effect": "allow" },
    { "action": "webfetch", "resource": "*", "effect": "allow" },
  ],
  "mcp": {
    "servers": {
      "kubernetes": {
        "type": "local",
        "command": ["sh", "-c", "exec npx -y kubernetes-mcp-server@latest"],
        "environment": { "KUBECONFIG": "/home/me/.kube/config" },
      },
      "flux": { "type": "remote", "url": "https://flux-mcp.example.com/mcp" },
      "playwright": { "type": "local", "command": ["npx", "-y", "@playwright/mcp@latest"], "disabled": true }
    }
  },
  "snapshots": true
}`;

test("OpenCode's newer format: providers, models, agents, compaction, permissions, and MCP servers", () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sb-opencode-')), 'opencode.jsonc');
  writeFileSync(file, CONFIG);
  const got = readOpenCode([file], {});

  // The server's model ID, not OpenCode's key for it; a `#variant` is the same model.
  expect(got.locals).toEqual([
    {
      providerId: 'vllm-direct',
      baseUrl: 'http://10.0.0.5:8000/v1',
      model: 'acme/Big-1.5-FP8',
      contextWindow: 262_144,
    },
  ]);
  expect(got.remotes).toEqual([
    {
      kind: 'openai-compatible',
      model: 'lil',
      baseUrl: 'https://vllm.example.com/v1',
      contextWindow: 65_536,
      maxOutputTokens: 16_384,
    },
    // A variant that sets something is a model of its own; an undefined one is the model.
    {
      kind: 'openai-compatible',
      model: 'lil',
      baseUrl: 'https://vllm.example.com/v1',
      contextWindow: 65_536,
      maxOutputTokens: 16_384,
      settings: { body: { chat_template_kwargs: { enable_thinking: false } } },
      variant: 'direct',
    },
    {
      kind: 'openai-compatible',
      model: 'acme/Big-1.5-FP8',
      baseUrl: 'https://vllm.example.com/v1',
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
      settings: { vision: true, temperature: 0.6, topP: 0.95, topK: 20, body: { min_p: 0 } },
    },
  ]);
  expect(got.current).toBe(got.locals[0]);

  expect(got.permissions).toEqual({
    levels: { bash: 'allow', edit: 'allow', web: 'allow' },
    allow: [],
    ask: ['bash(git push *)'],
    deny: ['bash(git reset --hard *)'],
  });
  expect(got.mcpServers).toEqual({
    kubernetes: {
      command: 'sh',
      args: ['-c', 'exec npx -y kubernetes-mcp-server@latest'],
      env: { KUBECONFIG: '/home/me/.kube/config' },
    },
    flux: { url: 'https://flux-mcp.example.com/mcp' },
    playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'], enabled: false },
  });
  // Denied tools become a tool list without them, and the agent's rules its own `permissions`.
  expect(got.agents).toEqual({
    build: { config: { maxSteps: 60 }, model: got.locals[0] },
    explore: { config: { maxSteps: 15 }, model: got.remotes[1] },
    plan: { config: {}, model: got.remotes[0] },
    reviewer: {
      config: {
        description: 'Reviews diffs',
        prompt: 'Review the change.',
        mode: 'subagent',
        tools: [
          'read',
          'glob',
          'grep',
          'bash',
          'task',
          'webfetch',
          'websearch',
          'mcp__kubernetes',
          'mcp__flux',
          'mcp__playwright',
        ],
        permissions: { edit: 'deny' },
      },
    },
    pls: {
      config: {
        description: 'The "pls" agent from OpenCode.',
        tools: [
          'read',
          'glob',
          'grep',
          'edit',
          'write',
          'bash',
          'task',
          'websearch',
          'merge_worktree',
          'mcp__kubernetes',
          'mcp__flux',
          'mcp__playwright',
        ],
      },
    },
  });
  // Token counts as fractions of the current model's 262,144-token window.
  expect(got.compaction).toEqual({ enabled: true, threshold: 0.8, keepRecent: 0.1 });
  expect(got.skipped).toEqual([
    expect.stringContaining("agent pls's temperature and top_p"),
    expect.stringContaining("OpenCode's own title agent settings"),
    expect.stringContaining('plugins: Switchback has its own format'),
    expect.stringContaining('formatter: Switchback has its own format'),
  ]);
});

// The V2 shapes from OpenCode's migration guide (opencode.ai/v2/docs/migrate-v1).
test('OpenCode V2 as its migration guide writes it', () => {
  const got = fromOpenCode(
    {
      model: 'anthropic/claude-sonnet-5#high',
      providers: {
        anthropic: {
          models: {
            'claude-sonnet-5': {
              variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }],
            },
          },
        },
        'google-vertex': { settings: { project: 'p', location: 'global' } },
      },
      agents: {
        reviewer: {
          system: 'Review carefully.',
          model: 'google-vertex/claude-opus-5@20260101',
          disabled: true,
          request: { body: { temperature: 0.2 } },
        },
      },
      mcp: {
        timeout: { startup: 45000, catalog: 30000, execution: 600000 },
        servers: { docs: { type: 'remote', url: 'https://mcp.example.com/mcp' } },
      },
      commands: { ship: { template: 'ship it' } },
      skills: ['./team-skills'],
    },
    {},
  );
  // A variant's `settings` make it a model of its own, with the effort it asks for.
  expect(got.current).toEqual({
    kind: 'anthropic',
    model: 'claude-sonnet-5',
    settings: { effort: 'high' },
    variant: 'high',
  });
  expect(got.remotes).toContainEqual({
    kind: 'vertex',
    model: 'claude-opus-5',
    projectId: 'p',
    region: 'global',
  });
  expect(got.agents?.reviewer?.config).toMatchObject({
    prompt: 'Review carefully.',
    disable: true,
  });
  // `mcp.timeout` is a setting, not a server.
  expect(got.mcpServers).toEqual({ docs: { url: 'https://mcp.example.com/mcp' } });
  expect(got.commands).toEqual({ ship: { template: 'ship it' } });
  expect(got.skipped).toEqual([
    expect.stringContaining("agent reviewer's temperature and top_p"),
    expect.stringContaining('skills: Switchback has its own format'),
  ]);
});

test("OpenCode V1's `api` is a custom provider's base URL", () => {
  const got = fromOpenCode(
    {
      model: 'acme/coder',
      provider: {
        acme: {
          npm: '@ai-sdk/openai-compatible',
          api: 'https://llm.example.com/v1',
          options: { apiKey: '{env:ACME_API_KEY}' },
          models: { coder: {} },
        },
      },
    },
    {},
  );
  expect(got.current).toMatchObject({
    kind: 'openai-compatible',
    baseUrl: 'https://llm.example.com/v1',
    apiKeyEnv: 'ACME_API_KEY',
  });
});
