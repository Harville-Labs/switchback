import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgents, parseAgentFile } from './agents.ts';
import { ConfigError, loadConfig, stripJsonComments } from './config.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-cfg-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('config', () => {
  test('defaults have no local model; the user sets that up', () => {
    const { config, sources } = loadConfig(dir, { HARNESS_HOME: join(dir, 'home') });
    expect(sources).toEqual([]);
    expect(config.models.local).toBeUndefined();
    expect(Object.values(config.providers).some((p) => p.type === 'openai-compatible')).toBe(false);
    expect(config.models.remote?.model).toBe('claude-opus-5');
    expect(config.routing.escalation.policy).toBe('auto');
  });

  test('project config deep-merges over defaults and resolves env references', () => {
    mkdirSync(join(dir, '.harness'));
    writeFileSync(
      join(dir, '.harness', 'config.json'),
      `{
        // comments are allowed
        "providers": {
          "anthropic": { "type": "anthropic", "apiKey": "{env:MY_KEY}" },
          "ollama": { "type": "openai-compatible", "baseUrl": "http://localhost:11434/v1" }
        },
        "models": {
          "local": { "provider": "ollama", "model": "llama3.3" },
          "remote": { "model": "claude-sonnet-5" }
        },
        "routing": { "budget": { "dailyUsd": 2 } }
      }`,
    );
    const { config, sources } = loadConfig(dir, {
      HARNESS_HOME: join(dir, 'home'),
      MY_KEY: 'sk-test',
    });
    expect(sources).toHaveLength(1);
    expect(config.models.local).toMatchObject({ provider: 'ollama', model: 'llama3.3' });
    // Deep merge: only the model changed; the default provider and window remain.
    expect(config.models.remote).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      contextWindow: 1_000_000,
    });
    expect(config.providers.anthropic).toMatchObject({ apiKey: 'sk-test' });
    expect(config.routing.budget.dailyUsd).toBe(2);
  });

  test('reports unknown providers clearly', () => {
    mkdirSync(join(dir, '.harness'));
    writeFileSync(
      join(dir, '.harness', 'config.json'),
      '{"models":{"x":{"provider":"nope","model":"m"}}}',
    );
    expect(() => loadConfig(dir, { HARNESS_HOME: join(dir, 'home') })).toThrow(ConfigError);
  });

  test('comment stripping leaves strings alone', () => {
    expect(JSON.parse(stripJsonComments('{"url":"http://x//y" /* c */}'))).toEqual({
      url: 'http://x//y',
    });
  });
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
