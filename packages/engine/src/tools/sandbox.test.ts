import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { type EngineEvent, PermissionMode } from '@switchback/protocol';
import { ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from '../config.ts';
import { Engine } from '../engine.ts';
import { bashTool } from './bash.ts';
import { CommandRunner } from './process.ts';
import { BashSandbox, DEFAULT_DENY_READ, type SandboxSettings, sandboxPolicy } from './sandbox.ts';

const settings = (over: Partial<SandboxSettings> = {}): SandboxSettings => ({
  ...SwitchbackConfig.parse({}).bash.sandbox,
  ...over,
});
const base = {
  workspaceRoot: '/work/repo',
  sessionRoot: '/work/repo',
  switchbackDirs: ['/home/me/.config/switchback'],
  rules: [],
  home: '/home/me',
};

// The sandbox never runs on Windows, and its policy is written in POSIX paths.
describe.skipIf(process.platform === 'win32')('sandbox policy', () => {
  test('writes go to the workspace, temp, and caches; credentials are unreadable', () => {
    const p = sandboxPolicy(settings(), base);
    expect(p.filesystem.allowWrite).toEqual(
      expect.arrayContaining(['/work/repo', '/tmp', '/home/me/.npm', '/home/me/.cargo/registry']),
    );
    expect(p.filesystem.denyRead).toEqual(
      expect.arrayContaining(['/home/me/.ssh', '/home/me/.aws', '/home/me/.config/switchback']),
    );
    expect(DEFAULT_DENY_READ).toContain('~/.ssh');
    expect(p.network.allowedDomains).toEqual(['*']);
  });

  test("the agent's own configuration and git hooks are never writable", () => {
    const p = sandboxPolicy(settings(), { ...base, sessionRoot: '/data/worktrees/x' });
    expect(p.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        '/work/repo/.switchback',
        '/work/repo/.git/hooks',
        '/work/repo/.git/config',
        '/data/worktrees/x/.mcp.json',
      ]),
    );
  });

  test('read and edit deny rules apply inside the sandbox', () => {
    const p = sandboxPolicy(settings(), {
      ...base,
      rules: [
        { rule: 'read(.env)', behavior: 'deny', source: 'test' },
        { rule: 'read(secrets/**)', behavior: 'deny', source: 'test' },
        { rule: 'edit(/dist/)', behavior: 'deny', source: 'test' },
        { rule: 'read(docs/**)', behavior: 'allow', source: 'test' },
      ],
    });
    expect(p.filesystem.denyRead).toEqual(
      expect.arrayContaining(['/work/repo/**/.env', '/work/repo/secrets/**']),
    );
    expect(p.filesystem.denyRead).not.toContain('/work/repo/docs/**');
    expect(p.filesystem.denyWrite).toContain('/work/repo/dist/**');
  });

  test('network: all, none, or a list of hosts', () => {
    expect(sandboxPolicy(settings({ network: 'none' }), base).network.allowedDomains).toEqual([]);
    expect(
      sandboxPolicy(settings({ network: ['registry.npmjs.org'] }), base).network.allowedDomains,
    ).toEqual(['registry.npmjs.org']);
  });

  test('mode on refuses to run when the sandbox is unavailable', async () => {
    const unavailable = {
      state: async () => ({ active: false as const, reason: 'bubblewrap is not installed' }),
    } as unknown as BashSandbox;
    const runner = new CommandRunner(
      () => ({ timeoutMs: 1_000, env: {}, sandbox: settings({ mode: 'on' }) }),
      () => {},
      { runtime: unavailable, context: () => base, notice: () => {} },
    );
    await expect(runner.spawn('echo hi', tmpdir())).rejects.toThrow(
      'bash.sandbox.mode is on, but bubblewrap is not installed; nothing ran',
    );
  });
});

const supported =
  process.platform !== 'win32' &&
  SandboxManager.isSupportedPlatform() &&
  !SandboxManager.checkDependencies().errors.length;

describe.skipIf(!supported)('the sandbox itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'switchback-sbx-'));
  const home = mkdtempSync(join(tmpdir(), 'switchback-sbx-home-'));
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
  writeFileSync(join(root, 'secret.txt'), 'hunter2');
  mkdirSync(join(root, '.switchback'));
  const runtime = new BashSandbox(join(root, '.data'));
  const runner = new CommandRunner(
    () => ({ timeoutMs: 20_000, env: {}, sandbox: settings({ mode: 'on' }) }),
    () => {},
    {
      runtime,
      context: (cwd) => ({
        ...base,
        workspaceRoot: root,
        sessionRoot: cwd,
        home,
        rules: [{ rule: 'read(secret.txt)', behavior: 'deny', source: 'test' }],
      }),
      notice: () => {},
    },
  );
  const ctx = {
    workspaceRoot: root,
    sessionId: 's',
    signal: new AbortController().signal,
    agentCatalog: [],
    commands: runner,
  };
  const bash = (command: string) => bashTool.run({ command }, ctx);
  afterAll(async () => {
    await runner.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test('writes inside the workspace work; outside it they fail', async () => {
    expect(await bash('echo ok > inside.txt && cat inside.txt')).toContain('ok');
    // Outside the workspace, temp, and caches: the real home directory.
    const outside = join(homedir(), `switchback-sandbox-${crypto.randomUUID().slice(0, 8)}.txt`);
    try {
      expect(await bash(`echo no > ${outside}`)).not.toContain('exit code: 0');
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("credentials, denied files, and the agent's config are off limits", async () => {
    expect(await bash(`cat ${join(home, '.ssh', 'id_ed25519')}`)).not.toContain('PRIVATE KEY');
    expect(await bash('cat secret.txt')).not.toContain('hunter2');
    await bash('echo \'{"permissions":{"allow":["bash"]}}\' > .switchback/config.local.json');
    expect(existsSync(join(root, '.switchback', 'config.local.json'))).toBe(false);
  });
});

describe('asking to leave the sandbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'switchback-sbx-gate-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function engine(script: { name: string; input: unknown }[], bash: object = {}) {
    const config = SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { local: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
      routing: { start: ['local'] },
      permissions: { bash: 'allow', edit: 'allow' },
      bash: { sandbox: bash },
    });
    const lp = new ScriptedProvider('lp', 'local', [{ toolCalls: script }, { text: 'done' }]);
    const e = new Engine({
      workspaceRoot: root,
      config,
      providers: new Map([['lp', lp]]),
      sandbox: false,
    });
    const events: EngineEvent[] = [];
    e.subscribe((ev) => events.push(ev));
    return { e, lp, events };
  }

  test('always asks, even when bash is allowed and in bypass mode', async () => {
    const { e, events } = engine([
      { name: 'bash', input: { command: 'echo hi', unsandboxed: true } },
    ]);
    e.subscribe((ev) => {
      if (ev.type === 'permission.requested') e.respondPermission(ev.requestId, 'deny');
    });
    const id = e.createSession({ permissionMode: PermissionMode.enum.bypassPermissions }).id;
    await e.runTurn(id, 'go');
    expect(events.find((ev) => ev.type === 'permission.requested')).toMatchObject({
      askRule: 'running outside the OS sandbox',
    });
  });

  test('is refused when allowUnsandboxed is off', async () => {
    const { e, lp } = engine([{ name: 'bash', input: { command: 'echo hi', unsandboxed: true } }], {
      allowUnsandboxed: false,
    });
    await e.runTurn(e.createSession({}).id, 'go');
    const result = lp.requests[1]?.messages.at(-1)?.parts[0] as { content: string };
    expect(result.content).toContain('bash.sandbox.allowUnsandboxed');
  });

  test("editing the agent's own configuration asks, even in accept-edits mode", async () => {
    const { e, events } = engine([
      { name: 'write', input: { path: '.switchback/config.local.json', content: '{}' } },
    ]);
    e.subscribe((ev) => {
      if (ev.type === 'permission.requested') e.respondPermission(ev.requestId, 'deny');
    });
    await e.runTurn(e.createSession({ permissionMode: 'acceptEdits' }).id, 'go');
    expect(events.find((ev) => ev.type === 'permission.requested')).toMatchObject({
      askRule: "Switchback's own configuration",
    });
  });
});
