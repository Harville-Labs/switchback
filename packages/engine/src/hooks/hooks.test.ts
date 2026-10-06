import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, Message, ToolResultPart } from '@switchback/protocol';
import { type Script, ScriptedProvider } from '@switchback/providers';
import { loadConfig, SwitchbackConfig } from '../config.ts';
import { Engine } from '../engine.ts';
import type { OrgPolicy } from '../org/policy.ts';
import { trust } from '../trust.ts';
import { hookTrustKey } from './layers.ts';
import { HookRunner } from './runner.ts';
import type { HooksConfig } from './schema.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-hooks-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const cmd = (command: string, timeout?: number) => ({
  type: 'command' as const,
  command,
  ...(timeout ? { timeout } : {}),
});

function runner(hooks: HooksConfig) {
  const notes: string[] = [];
  const r = new HookRunner({
    hooks: () => hooks,
    workspaceRoot: root,
    argv: (c) => ['/bin/sh', '-c', c],
    notify: (_level, m) => notes.push(m),
  });
  return { r, notes };
}

describe('hook runner', () => {
  test('stdin carries the event; exit 2 blocks with stderr', async () => {
    const { r } = runner({
      PreToolUse: [{ matcher: 'Bash', hooks: [cmd('cat > event.json; echo "no rm" >&2; exit 2')] }],
    });
    const out = await r.run(
      'PreToolUse',
      { tool_name: 'bash', tool_input: { command: 'rm x' } },
      'bash',
    );
    expect(out.block).toBe('no rm');
    const event = JSON.parse(readFileSync(join(root, 'event.json'), 'utf8'));
    expect(event).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'bash', cwd: root });
  });

  test("matchers take our tool names and Claude Code's", async () => {
    const { r } = runner({ PreToolUse: [{ matcher: 'Edit|Write', hooks: [cmd('exit 2')] }] });
    expect((await r.run('PreToolUse', {}, 'write')).block).toBeDefined();
    expect((await r.run('PreToolUse', {}, 'bash')).block).toBeUndefined();
  });

  test('JSON output decides; deny beats ask beats allow', async () => {
    const decide = (d: string) =>
      cmd(
        `echo '{"hookSpecificOutput":{"permissionDecision":"${d}","permissionDecisionReason":"${d} it"}}'`,
      );
    const { r } = runner({
      PreToolUse: [{ hooks: [decide('allow'), decide('deny'), decide('ask')] }],
    });
    expect((await r.run('PreToolUse', {}, 'bash')).decision).toEqual({
      behavior: 'deny',
      reason: 'deny it',
    });
  });

  test('plain stdout is context; failures and timeouts only warn', async () => {
    const { r, notes } = runner({
      UserPromptSubmit: [
        { hooks: [cmd('echo "branch: main"'), cmd('exit 1'), cmd('sleep 5', 0.2)] },
      ],
    });
    const out = await r.run('UserPromptSubmit', { prompt: 'hi' });
    expect(out).toEqual({ context: ['branch: main'] });
    expect(notes.some((n) => n.includes('failed (exit 1)'))).toBe(true);
    expect(notes.some((n) => n.includes('timed out after 0.2s'))).toBe(true);
  });
});

describe('hooks in a session', () => {
  function engine(script: Script, hooks: HooksConfig, permissions: object = { bash: 'ask' }) {
    const config = SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { local: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
      routing: { start: ['local'] },
      permissions,
      hooks,
    });
    const lp = new ScriptedProvider('lp', 'local', script);
    const e = new Engine({
      workspaceRoot: root,
      config,
      providers: new Map([['lp', lp]]),
      interaction: 'deny',
    });
    const events: EngineEvent[] = [];
    e.subscribe((ev) => events.push(ev));
    return { e, lp, events };
  }
  const echo = { toolCalls: [{ name: 'bash', input: { command: 'echo hi' } }] };
  const resultOf = (lp: ScriptedProvider) =>
    lp.requests[1]?.messages.at(-1)?.parts[0] as ToolResultPart;
  const reminders = (m: Message | undefined) =>
    (m?.parts ?? []).flatMap((p) => (p.type === 'text' && p.reminder ? [p.text] : []));

  test('PreToolUse can deny a call, or allow one a level would ask about', async () => {
    const denied = engine([echo, { text: 'ok' }], {
      PreToolUse: [{ matcher: 'bash', hooks: [cmd('echo "not today" >&2; exit 2')] }],
    });
    await denied.e.runTurn(denied.e.createSession({}).id, 'go');
    expect(resultOf(denied.lp).content).toBe('Blocked by a PreToolUse hook: not today');

    const allowed = engine([echo, { text: 'ok' }], {
      PreToolUse: [
        { hooks: [cmd(`echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'`)] },
      ],
    });
    await allowed.e.runTurn(allowed.e.createSession({}).id, 'go');
    expect(resultOf(allowed.lp).content).toContain('stdout:\nhi');
  });

  test('a hook allow never overrides a deny rule', async () => {
    const { e, lp } = engine(
      [echo, { text: 'ok' }],
      { PreToolUse: [{ hooks: [cmd(`echo '{"decision":"approve"}'`)] }] },
      { bash: 'allow', deny: ['bash(echo:*)'] },
    );
    await e.runTurn(e.createSession({}).id, 'go');
    expect(resultOf(lp).content).toContain('Denied by the permission rule bash(echo:*)');
  });

  test('PostToolUse feedback reaches the model with the result', async () => {
    const { e, lp } = engine(
      [echo, { text: 'ok' }],
      { PostToolUse: [{ hooks: [cmd('echo "lint failed" >&2; exit 2')] }] },
      { bash: 'allow' },
    );
    await e.runTurn(e.createSession({}).id, 'go');
    expect(resultOf(lp).content).toEndWith('PostToolUse hook: lint failed');
  });

  test('UserPromptSubmit and SessionStart add context; a block stops the prompt', async () => {
    const ctx = engine([{ text: 'ok' }], {
      SessionStart: [{ matcher: 'startup', hooks: [cmd('echo "on branch main"')] }],
      UserPromptSubmit: [{ hooks: [cmd('echo "ticket ABC-1"')] }],
    });
    await ctx.e.runTurn(ctx.e.createSession({}).id, 'hello');
    expect(reminders(ctx.lp.requests[0]?.messages.at(-1))).toEqual([
      'on branch main',
      'ticket ABC-1',
    ]);

    const blocked = engine([{ text: 'never' }], {
      UserPromptSubmit: [{ hooks: [cmd('echo "no secrets in prompts" >&2; exit 2')] }],
    });
    const r = await blocked.e.runTurn(blocked.e.createSession({}).id, 'my password is x');
    expect(r.stopReason).toBe('error');
    expect(blocked.lp.requests).toHaveLength(0);
    expect(blocked.events.find((ev) => ev.type === 'error')).toMatchObject({
      message: 'A UserPromptSubmit hook blocked the prompt: no secrets in prompts',
    });
  });

  test('a Notification hook hears when Switchback waits on the user', async () => {
    const config = SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { local: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
      routing: { start: ['local'] },
      permissions: { bash: 'ask' },
      hooks: { Notification: [{ hooks: [cmd('cat > notified.json')] }] },
    });
    const lp = new ScriptedProvider('lp', 'local', [echo, { text: 'ok' }]);
    const e = new Engine({
      workspaceRoot: root,
      config,
      providers: new Map([['lp', lp]]),
    });
    e.subscribe((ev) => {
      if (ev.type === 'permission.requested') e.respondPermission(ev.requestId, 'deny');
    });
    await e.runTurn(e.createSession({}).id, 'go');
    for (let i = 0; i < 50; i++) {
      try {
        const got = JSON.parse(readFileSync(join(root, 'notified.json'), 'utf8'));
        expect(got).toMatchObject({
          hook_event_name: 'Notification',
          message: 'Switchback needs your permission: $ echo hi',
        });
        return;
      } catch {
        await Bun.sleep(20);
      }
    }
    throw new Error('the Notification hook never ran');
  });

  test('a Stop hook sends the model back to work, a few times at most', async () => {
    const { e, lp } = engine(() => ({ text: 'done?' }), {
      Stop: [{ hooks: [cmd('echo "tests still fail" >&2; exit 2')] }],
    });
    await e.runTurn(e.createSession({}).id, 'fix it');
    expect(lp.requests).toHaveLength(4); // the first answer and three continuations
    expect(reminders(lp.requests[1]?.messages.at(-1))).toEqual([
      "A Stop hook says the work isn't done: tests still fail",
    ]);
  });
});

describe('hooks in config', () => {
  const hook = (command: string) => ({ hooks: { Stop: [{ hooks: [cmd(command)] }] } });

  test("add up across layers; a project's wait for trust; another agent's are never read", () => {
    const home = mkdtempSync(join(tmpdir(), 'switchback-hooks-home-'));
    try {
      const env = { SWITCHBACK_HOME: home };
      writeFileSync(join(home, 'config.json'), JSON.stringify(hook('echo user')));
      mkdirSync(join(root, '.switchback'));
      writeFileSync(join(root, '.switchback', 'config.json'), JSON.stringify(hook('echo project')));
      mkdirSync(join(root, '.claude'));
      writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(hook('echo claude')));
      const before = loadConfig(root, env, [], null);
      expect(before.config.hooks.Stop?.map((m) => m.hooks[0]?.command)).toEqual(['echo user']);
      // Claude Code's settings are its own; Switchback doesn't run its hooks.
      expect(before.untrustedHooks.map((h) => h.source)).toEqual(['.switchback/config.json']);
      trust(
        root,
        Object.fromEntries(before.untrustedHooks.map((h) => [hookTrustKey(h), h.matcher])),
        env,
      );
      const after = loadConfig(root, env, [], null);
      expect(after.config.hooks.Stop?.map((m) => m.hooks[0]?.command)).toEqual([
        'echo user',
        'echo project',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an organization can allow only its own hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'switchback-hooks-home-'));
    try {
      writeFileSync(join(home, 'config.json'), JSON.stringify(hook('echo user')));
      const policy: OrgPolicy = {
        version: '1',
        org: { id: 'o', name: 'Acme' },
        defaults: {},
        enforced: hook('audit-log'),
        restrictions: {
          allowRemote: true,
          allowUserProviders: true,
          allowUserMcpServers: true,
          allowUserPermissionRules: true,
          allowUserHooks: false,
          allowBypassPermissions: true,
        },
        refreshSeconds: 300,
      };
      const loaded = loadConfig(root, { SWITCHBACK_HOME: home }, [], policy);
      expect(loaded.config.hooks.Stop?.map((m) => m.hooks[0]?.command)).toEqual(['audit-log']);
      expect(loaded.org?.notes.some((n) => n.includes('only organization hooks run'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
