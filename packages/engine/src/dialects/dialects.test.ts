import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { applyDialect, dialectOf } from './index.ts';
import { translateCommands } from './opencode-commands.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchback-dialect-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A project whose `.switchback/config.json` is written in OpenCode's format. */
function project(config: string) {
  const ws = join(dir, 'ws');
  mkdirSync(join(ws, '.switchback'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  writeFileSync(join(ws, '.switchback', 'config.json'), config);
  return loadConfig(ws, { SWITCHBACK_HOME: join(dir, 'home') }, [], null);
}

const OPENCODE = `{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "build",
  // Comments are fine
  "agents": {
    "build": {
      "model": "vllm-ornith/big",
      "steps": 60,
      "permissions": [{ "action": "subagent", "resource": "*", "effect": "allow" }]
    },
    "researcher": {
      "description": "Research a question",
      "mode": "subagent",
      "model": "fast",
      "color": "4C8BF5",
      "steps": 12,
      "system": "Be brief."
    }
  },
  "commands": {
    "ark-issue": {
      "description": "Open an issue",
      "subagent": false,
      "template": "Create an issue: $ARGUMENTS"
    },
    "triage": { "template": "Triage $1", "subagent": true, "agent": "researcher" }
  }
}`;

test('a config declaring the OpenCode schema is read as Switchback config', () => {
  const { config, warnings } = project(OPENCODE);
  expect(config.defaultAgent).toBe('build');
  expect(config.agents.researcher).toMatchObject({
    description: 'Research a question',
    mode: 'subagent',
    model: 'fast',
    color: '4C8BF5',
    maxSteps: 12,
    prompt: 'Be brief.',
  });
  expect(config.agents.build).toMatchObject({ maxSteps: 60 });
  expect(config.commands['ark-issue']).toEqual({
    description: 'Open an issue',
    subagent: false,
    template: 'Create an issue: $ARGUMENTS',
  });
  expect(config.commands.triage).toMatchObject({ subagent: true, agent: 'researcher' });
  // OpenCode's provider/model references can't be resolved to an alias here.
  expect(warnings.join('\n')).toContain("agent build's model vllm-ornith/big");
  expect(warnings[0]).toContain('(OpenCode format)');
});

test('a config with no schema, or its own, is left as it is', () => {
  const own = { $schema: 'https://switchback.sh/config.schema.json', agents: { a: {} } };
  expect(dialectOf(own)).toBeUndefined();
  expect(applyDialect(own)).toEqual({ config: own, notes: [] });
  expect(applyDialect({ agents: {} }).config).toEqual({ agents: {} });
});

test('providers, models, and MCP servers are left for setup, with a pointer to it', () => {
  const { config, warnings } = project(
    '{"$schema":"https://opencode.ai/config.json","model":"acme/coder","mcp":{"docs":{"type":"remote","url":"https://x"}}}',
  );
  expect(config.mcpServers).toEqual({});
  expect(warnings.join('\n')).toContain('switchback init --from opencode');
});

test("OpenCode's commands come over; ones Switchback can't run say why", () => {
  const skipped: string[] = [];
  const got = translateCommands(
    {
      fix: {
        template: 'Fix $1',
        description: 'Fix it',
        agent: 'build',
        subagent: true,
        model: 'a/b',
      },
      'Bad Name': { template: 'x' },
      loaded: { template: '{file:./prompt.md}' },
      shell: { template: 'Status: !`git status`' },
    },
    skipped,
  );
  expect(got).toEqual({
    fix: { template: 'Fix $1', description: 'Fix it', agent: 'build', subagent: true },
    shell: { template: 'Status: !`git status`' },
  });
  expect(skipped.join('\n')).toContain('Bad Name');
  expect(skipped.join('\n')).toContain('file reference');
  expect(skipped.join('\n')).toContain('runs shell commands');
  expect(skipped.join('\n')).toContain('the model set on 1 command');
});

const CLAUDE = `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": ["Bash(npm run test:*)", "Read(~/.zshrc)", "Task(explore)"],
    "ask": ["Bash(git push:*)"],
    "deny": ["Read(./.env)", "WebFetch(domain:evil.example)"],
    "defaultMode": "acceptEdits",
    "additionalDirectories": ["../docs"]
  },
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "bunx biome format --write ." }] }
    ],
    "Stop": [{ "hooks": [{ "type": "prompt", "prompt": "Is it done?" }] }]
  },
  "mcpServers": {
    "docs": { "type": "http", "url": "https://mcp.example.com/mcp" },
    "fs": { "command": "npx", "args": ["-y", "fs-mcp"], "env": { "ROOT": "/tmp" } }
  },
  "env": { "FOO": "1" },
  "model": "opus"
}`;

test('a config declaring Claude Code settings keeps its rules, mode, hooks, and MCP servers', () => {
  const { config, warnings, rules, untrustedHooks } = project(CLAUDE);
  expect(config.permissions.level).toBe('ask');
  expect(config.permissions.ask).toContain('Bash(git push:*)');
  expect(rules.find((r) => r.rule === 'Read(./.env)')?.behavior).toBe('deny');
  // A project's hooks wait for trust, as they do in Switchback's own format.
  expect(untrustedHooks.map((h) => [h.event, h.matcher.matcher])).toEqual([
    ['PostToolUse', 'Edit|Write'],
  ]);
  expect(Object.keys(config.mcpServers).sort()).toEqual(['docs', 'fs']);
  const text = warnings.join('\n');
  expect(text).toContain('acceptEdits');
  expect(text).toContain('(Claude Code format)');
  expect(text).toContain('allow rule Task(explore)');
  expect(text).toContain("a Stop hook that isn't a command");
  expect(text).toContain('additionalDirectories');
  expect(text).toContain('env, model');
});

test('Claude Code settings and OpenCode config are told apart by their $schema', () => {
  expect(dialectOf({ $schema: 'https://json.schemastore.org/claude-code-settings.json' })?.id).toBe(
    'claude-code',
  );
  expect(dialectOf({ $schema: 'https://opencode.ai/config.json' })?.id).toBe('opencode');
});
