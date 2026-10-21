import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOpenCode } from './from-opencode.ts';

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
    "title": { "model": "vllm/lil#direct" }
  },
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

test("OpenCode's newer format: providers, models, agents' models, permissions, and MCP servers", () => {
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
  expect(got.skipped).toEqual([
    expect.stringContaining('agent: Switchback has its own format'),
    expect.stringContaining('plugins: Switchback has its own format'),
    expect.stringContaining('formatter: Switchback has its own format'),
  ]);
});
