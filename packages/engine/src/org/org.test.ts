import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrgClient } from '@harville-labs/switchback-org/client';
import type { EngineEvent } from '@switchback/protocol';
import { ScriptedProvider } from '@switchback/providers';
import { loadConfig, SwitchbackConfig } from '../config.ts';
import { Engine } from '../engine.ts';
import { adoptOrgPermissions } from './adopt.ts';
import { startDevOrgServer } from './dev-server.ts';
import { applyRestrictions, OrgPolicy } from './policy.ts';
import { clearAuth, readAuth, readCachedPolicy, toAuth, writeAuth } from './store.ts';
import { OrgSync, refreshPolicy } from './sync.ts';

let home: string;
let env: Record<string, string>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchback-org-'));
  env = { SWITCHBACK_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const base = SwitchbackConfig.parse({
  providers: {
    gpu: { type: 'openai-compatible', baseUrl: 'http://gpu:8000/v1', tier: 'local' },
    openai: { type: 'openai' },
    deepseek: { type: 'deepseek' },
  },
  models: {
    local: { provider: 'gpu', model: 'coder' },
    remote: { provider: 'openai', model: 'gpt-6-sol' },
    haiku: { provider: 'deepseek', model: 'deepseek-flash' },
  },
  routing: { start: ['local'], escalate: [['remote']], budget: { dailyUsd: 50 } },
});
const policy = (p: Record<string, unknown>) =>
  OrgPolicy.parse({ version: 1, org: { id: 'acme', name: 'Acme' }, ...p });

describe('restrictions', () => {
  test('allowRemote: false strips remote providers, turns remote off, and prunes roles', () => {
    const { config, notes } = applyRestrictions(
      base,
      policy({ restrictions: { allowRemote: false } }),
    );
    expect(Object.keys(config.providers)).toEqual(['gpu']);
    expect(Object.keys(config.models)).toEqual(['local']);
    expect(config.routing).toMatchObject({ allowRemote: false, start: ['local'], escalate: [] });
    expect(notes).toContain('provider "openai" removed: remote providers are disabled');
    expect(notes).toContain('routing.escalate: "remote" removed with its provider');
  });

  test('provider type allowlist and org-only providers', () => {
    const typed = applyRestrictions(
      base,
      policy({ restrictions: { allowedProviderTypes: ['openai-compatible', 'openai'] } }),
    );
    expect(Object.keys(typed.config.providers).sort()).toEqual(['gpu', 'openai']);
    const orgOnly = applyRestrictions(
      base,
      policy({ defaults: { providers: { gpu: {} } }, restrictions: { allowUserProviders: false } }),
    );
    expect(Object.keys(orgOnly.config.providers)).toEqual(['gpu']);
  });

  test('org-only MCP servers', () => {
    const withMcp = SwitchbackConfig.parse({
      ...base,
      mcpServers: { jira: { url: 'https://mcp.acme.internal/jira' }, mine: { command: 'x' } },
    });
    const r = applyRestrictions(
      withMcp,
      policy({
        defaults: { mcpServers: { jira: { url: 'https://mcp.acme.internal/jira' } } },
        restrictions: { allowUserMcpServers: false },
      }),
    );
    expect(Object.keys(r.config.mcpServers)).toEqual(['jira']);
    expect(r.notes).toContain(
      'MCP server "mine" removed: only organization-defined MCP servers are allowed',
    );
    expect(Object.keys(applyRestrictions(withMcp, policy({})).config.mcpServers)).toHaveLength(2);
  });

  test('budget caps only ever lower the budget', () => {
    const capped = applyRestrictions(
      base,
      policy({ restrictions: { maxDailyUsd: 10, maxMonthlyUsd: 100 } }),
    );
    expect(capped.config.routing.budget).toMatchObject({ dailyUsd: 10, monthlyUsd: 100 });
    const lower = applyRestrictions(
      { ...base, routing: { ...base.routing, budget: { ...base.routing.budget, dailyUsd: 3 } } },
      policy({ restrictions: { maxDailyUsd: 10 } }),
    );
    expect(lower.config.routing.budget.dailyUsd).toBe(3);
  });
});

describe('layering', () => {
  test('org defaults sit under the user; enforced sits over everything', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        permissions: { edit: 'allow', bash: 'allow' },
        models: { local: { model: 'mine' } },
      }),
    );
    const { config, org } = loadConfig(
      home,
      env,
      [],
      policy({
        defaults: {
          providers: { gpu: { type: 'openai-compatible', baseUrl: 'http://gpu.acme.internal/v1' } },
          models: { local: { provider: 'gpu', model: 'acme-coder' } },
          permissions: { edit: 'ask' },
        },
        enforced: { permissions: { bash: 'deny' } },
      }),
    );
    expect(config.models.local).toMatchObject({ provider: 'gpu', model: 'mine' }); // user adjusted the org default
    expect(config.permissions).toMatchObject({ edit: 'allow', bash: 'deny' }); // enforced wins
    expect(org?.enforcedKeys).toEqual(['permissions.bash']);
  });

  const gpuPolicy = policy({
    defaults: {
      providers: { gpu: { type: 'openai-compatible', baseUrl: 'http://gpu.acme.internal/v1' } },
      models: { 'acme-coder': { provider: 'gpu', model: 'acme-coder' } },
      routing: { start: ['local', 'acme-coder'] },
    },
  });

  test("a policy's role may name a model only some members have", () => {
    const without = loadConfig(home, env, [], gpuPolicy);
    expect(without.config.routing.start).toEqual(['acme-coder']);
    expect(without.org?.notes).toContain(
      'routing.start: "local" skipped; no model has that alias here',
    );
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        providers: { ollama: { type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' } },
        models: { local: { provider: 'ollama', model: 'qwen' } },
      }),
    );
    const withLocal = loadConfig(home, env, [], gpuPolicy);
    expect(withLocal.config.routing.start).toEqual(['local', 'acme-coder']);
    expect(withLocal.org?.notes).toEqual([]);
  });

  test("the member's own misspelled role alias is still an error", () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ routing: { start: ['acme-codr'] } }));
    expect(() => loadConfig(home, env, [], gpuPolicy)).toThrow(
      'routing.start[0] references unknown model "acme-codr"',
    );
  });
});

describe('with an organization server', () => {
  test('device sign-in, cached policy, live update disables remote mid-session, usage upload', async () => {
    let current: Record<string, unknown> = {
      defaults: {
        providers: {
          gpu: { type: 'openai-compatible', baseUrl: 'http://gpu/v1' },
          cloud: { type: 'mock', tier: 'remote' },
        },
        models: {
          local: { provider: 'gpu', model: 'coder' },
          remote: { provider: 'cloud', model: 'big' },
        },
        routing: { start: ['local'], escalate: [['remote']] },
      },
    };
    const server = startDevOrgServer({ policy: () => current, autoApprove: true });
    try {
      // Sign in with the device flow.
      const client = new OrgClient(server.url);
      const code = await client.startDeviceLogin();
      const token = await client.waitForDeviceToken(code);
      writeAuth(toAuth(server.url, token, { id: 'unused', name: 'unused' }), env);
      expect(readAuth(env)?.org.name).toBe('Dev Org');

      expect((await refreshPolicy(env)).changed).toBe(true);
      expect((await refreshPolicy(env)).changed).toBe(false); // ETag: 304

      // An engine configured from the cached policy.
      const reload = () => loadConfig(home, env);
      const first = reload();
      const lp = new ScriptedProvider('gpu', 'local', () => ({ text: 'local answer' }));
      const rp = new ScriptedProvider('cloud', 'remote', () => ({ text: 'remote answer' }));
      const engine = new Engine({
        workspaceRoot: home,
        config: first.config,
        providers: new Map([
          ['gpu', lp],
          ['cloud', rp],
        ]),
        ...(first.org ? { org: first.org } : {}),
      });
      const events: EngineEvent[] = [];
      engine.subscribe((e) => events.push(e));
      const s = engine.createSession({});
      expect((await engine.runTurn(s.id, 'hi', 'remote')).text).toBe('remote answer');

      // The admin disables remote; the running engine follows.
      current = { ...current, restrictions: { allowRemote: false } };
      const sync = new OrgSync({
        env,
        onPolicyChanged: () => engine.applyConfig(reload()),
        usageSince: (iso) => engine.usageEntriesSince(iso),
      });
      await sync.tick();
      sync.stop();
      const updated = events.find((e) => e.type === 'config.updated');
      expect(updated).toMatchObject({ org: { name: 'Dev Org' } });
      expect(updated?.type === 'config.updated' && updated.notes).toContain(
        'provider "cloud" removed: remote providers are disabled',
      );
      const r = await engine.runTurn(s.id, 'again', 'auto');
      expect(r.text).toBe('local answer');
      const blocked = await engine.runTurn(s.id, 'please use remote', 'remote');
      expect(blocked.stopReason).toBe('error');
      expect(events.findLast((e) => e.type === 'error')).toMatchObject({
        message: 'remote models are disabled by Dev Org policy',
      });

      // Usage was reported, aggregated by model.
      expect(server.usage.some((u) => u.model === 'big' && u.tier === 'remote')).toBe(true);
    } finally {
      server.stop();
    }
  });

  test('signing out removes the policy; a bad token keeps the cache', async () => {
    const server = startDevOrgServer({ policy: { restrictions: { allowRemote: false } } });
    try {
      writeAuth(
        { server: server.url, accessToken: server.token(), org: { id: 'x', name: 'X' }, user: {} },
        env,
      );
      await refreshPolicy(env);
      expect(readCachedPolicy(env)).toBeDefined();
      writeAuth(
        { server: server.url, accessToken: 'revoked', org: { id: 'x', name: 'X' }, user: {} },
        env,
      );
      const r = await refreshPolicy(env);
      expect(r.error).toContain('not authorized');
      expect(loadConfig(home, env).org?.name).toBe('Dev Org'); // still enforced offline
      clearAuth(env);
      expect(loadConfig(home, env).org).toBeUndefined();
    } finally {
      server.stop();
    }
  });
});

describe('permissions', () => {
  test('signing in replaces the member config permissions with the policy', () => {
    const file = join(home, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        telemetry: { enabled: false },
        permissions: { bash: 'allow', allow: ['bash(curl:*)'] },
      }),
    );
    const p = policy({
      defaults: { permissions: { edit: 'allow', allow: ['bash(git log:*)'] } },
      enforced: { permissions: { allow: ['bash(make:*)'], deny: ['read(.env)'] } },
    });
    adoptOrgPermissions(file, p);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.permissions).toEqual({
      edit: 'allow',
      allow: ['bash(git log:*)', 'bash(make:*)'],
      deny: ['read(.env)'],
    });
    expect(written.telemetry).toEqual({ enabled: false });
    expect(adoptOrgPermissions(file, policy({}))).toBeUndefined();
  });

  test('allowUserPermissions: false ignores members levels and rules, not their denies', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        permissions: { bash: 'allow', allow: ['bash(curl:*)'], deny: ['read(.env)'] },
      }),
    );
    const loaded = loadConfig(
      home,
      env,
      [],
      policy({
        defaults: { permissions: { edit: 'allow' } },
        restrictions: { allowUserPermissions: false },
      }),
    );
    expect(loaded.config.permissions.bash).toBe('ask');
    expect(loaded.config.permissions.edit).toBe('allow');
    expect(loaded.config.permissions.allow).toEqual([]);
    expect(loaded.config.permissions.deny).toEqual(['read(.env)']);
    expect(loaded.org?.userPermissionsDisabled).toBe(true);
    expect(loaded.org?.notes.join('\n')).toContain('permissions.bash from');
  });
});
