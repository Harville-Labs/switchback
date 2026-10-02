import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgents, parseAgentFile, renderAgentFile } from './agents.ts';
import { ConfigError, loadConfig, parseJsonc } from './config.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchback-cfg-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('config', () => {
  test('defaults choose no vendor: no providers, no models', () => {
    const { config, sources } = loadConfig(dir, { SWITCHBACK_HOME: join(dir, 'home') });
    expect(sources).toEqual([]);
    expect(config.providers).toEqual({});
    expect(config.models).toEqual({});
    expect(config.routing.escalation.policy).toBe('auto');
  });

  test('project config deep-merges over defaults and resolves env references', () => {
    mkdirSync(join(dir, '.switchback'));
    writeFileSync(
      join(dir, '.switchback', 'config.json'),
      `{
        // comments are allowed
        "providers": {
          "deepseek": { "type": "deepseek", "apiKey": "{env:MY_KEY}" },
          "ollama": { "type": "openai-compatible", "baseUrl": "http://localhost:11434/v1" }
        },
        "models": {
          "local": { "provider": "ollama", "model": "llama3.3" },
          "remote": { "provider": "deepseek", "model": "deepseek-flash", "contextWindow": 1000000 }
        },
        "routing": { "budget": { "dailyUsd": 2 } }
      }`,
    );
    const { config, sources } = loadConfig(dir, {
      SWITCHBACK_HOME: join(dir, 'home'),
      MY_KEY: 'sk-test',
    });
    expect(sources).toHaveLength(1);
    expect(config.models.local).toMatchObject({ provider: 'ollama', model: 'llama3.3' });
    expect(config.providers.deepseek).toMatchObject({ baseUrl: 'https://api.deepseek.com' });
    expect(config.providers.deepseek).toMatchObject({ apiKey: 'sk-test' });
    expect(config.routing.budget.dailyUsd).toBe(2);
  });

  test('reports unknown providers clearly', () => {
    mkdirSync(join(dir, '.switchback'));
    writeFileSync(
      join(dir, '.switchback', 'config.json'),
      '{"models":{"x":{"provider":"nope","model":"m"}}}',
    );
    expect(() => loadConfig(dir, { SWITCHBACK_HOME: join(dir, 'home') })).toThrow(ConfigError);
  });

  test('JSONC: comments and trailing commas, strings untouched, errors located', () => {
    expect(parseJsonc('{"url":"http://x//y" /* c */, // t\n}')).toEqual({ url: 'http://x//y' });
    expect(() => parseJsonc('{\n  "a": 1\n  "b": 2\n}')).toThrow('line 3, column 3: CommaExpected');
  });
});

test('an unknown model in a role is a config error, not a silent gap', () => {
  mkdirSync(join(dir, '.switchback'), { recursive: true });
  writeFileSync(
    join(dir, '.switchback', 'config.json'),
    JSON.stringify({
      providers: { ollama: { type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' } },
      models: { local: { provider: 'ollama', model: 'small' } },
      routing: { start: ['local'], escalate: ['larg'] },
    }),
  );
  expect(() => loadConfig(dir, { SWITCHBACK_HOME: join(dir, 'home') })).toThrow(
    'routing.escalate[0] references unknown model "larg"',
  );
});

test('keys removed by role-based routing say what replaced them', () => {
  mkdirSync(join(dir, '.switchback'), { recursive: true });
  for (const [routing, message] of [
    [{ local: ['a'] }, 'routing.local was renamed routing.start'],
    [{ remote: ['a'] }, 'routing.remote was replaced by routing.escalate'],
    [{ mode: 'local-only' }, 'routing.allowRemote: false'],
    [{ escalation: { via: ['a'] } }, 'routing.escalation.via was replaced'],
    [{ fallback: { onLocalUnavailable: 'fail' } }, 'routing.fallback is now "nearest"'],
  ] as const) {
    writeFileSync(join(dir, '.switchback', 'config.json'), JSON.stringify({ routing }));
    expect(() => loadConfig(dir, { SWITCHBACK_HOME: join(dir, 'home') })).toThrow(message);
  }
});

describe('agents', () => {
  test('parses Claude Code agent files unchanged', () => {
    const agent = parseAgentFile(
      `---
name: reviewer
description: Reviews diffs for bugs
tools: Read, Grep, Glob, Bash
model: sonnet
---
You review code.`,
      'reviewer.md',
      'claude-compat',
    );
    expect(agent).toMatchObject({
      name: 'reviewer',
      tools: ['read', 'grep', 'glob', 'bash'],
      model: 'sonnet',
      route: 'auto',
      prompt: 'You review code.',
    });
  });

  test('model: local pins the tier; inherit means no pin', () => {
    const local = parseAgentFile('---\ndescription: d\nmodel: local\n---\nx', 'a.md', 'project');
    const inherit = parseAgentFile(
      '---\ndescription: d\nmodel: inherit\n---\nx',
      'b.md',
      'project',
    );
    expect(local).toMatchObject({ route: 'local' });
    expect(local.model).toBeUndefined();
    expect(inherit.model).toBeUndefined();
  });

  test('project agents override built-ins; bad files are reported, not fatal', () => {
    mkdirSync(join(dir, 'agents'));
    writeFileSync(join(dir, 'agents', 'explore.md'), '---\ndescription: custom explore\n---\nmine');
    writeFileSync(join(dir, 'agents', 'broken.md'), 'no frontmatter');
    const { agents, errors } = loadAgents([{ dir: join(dir, 'agents'), source: 'project' }]);
    expect(agents.get('explore')?.description).toBe('custom explore');
    expect(agents.get('build')?.source).toBe('builtin');
    expect(errors).toHaveLength(1);
  });
});

describe('agent files', () => {
  test('renderAgentFile round-trips through the parser, switchback extensions included', () => {
    const text = renderAgentFile({
      name: 'db-migrator',
      description: 'Writes schema migrations: "safe" ones only. Use for any DB change.',
      prompt: 'You write migrations.',
      tools: ['read', 'edit', 'mcp__postgres'],
      model: 'local',
      budgetUsd: 0.25,
      isolation: 'worktree',
    });
    const agent = parseAgentFile(text, 'db-migrator.md', 'project');
    expect(agent).toMatchObject({
      name: 'db-migrator',
      description: 'Writes schema migrations: "safe" ones only. Use for any DB change.',
      tools: ['read', 'edit', 'mcp__postgres'],
      route: 'local',
      budgetUsd: 0.25,
      isolation: 'worktree',
      prompt: 'You write migrations.',
    });
    expect(() => renderAgentFile({ name: 'Bad', description: 'd', prompt: 'p' })).toThrow(
      'lowercase',
    );
    expect(() => renderAgentFile({ name: 'ok', description: ' ', prompt: 'p' })).toThrow(
      'description',
    );
  });
});
