import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromTranscript } from '@switchback/client';
import type { EngineEvent, PermissionMode, ToolResultPart } from '@switchback/protocol';
import { type Script, ScriptedProvider } from '@switchback/providers';
import { loadConfig, SwitchbackConfig } from '../config.ts';
import { Engine, type EngineOptions } from '../engine.ts';
import type { OrgPolicy } from '../org/policy.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-perm-'));
  writeFileSync(join(root, 'a.txt'), 'alpha\n');
  writeFileSync(join(root, '.env'), 'TOKEN=alpha\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(
  script: Script,
  permissions: object = {},
  opts: Partial<Omit<EngineOptions, 'config'>> = {},
) {
  const config = SwitchbackConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' } },
    models: { local: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
    routing: { start: ['local'] },
    permissions,
  });
  const lp = new ScriptedProvider('lp', 'local', script);
  const engine = new Engine({
    workspaceRoot: root,
    config,
    providers: new Map([['lp', lp]]),
    userConfigFile: join(root, 'user-config.json'),
    ...opts,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, lp, events };
}

/** The tool results the model saw on its second call. */
function results(lp: ScriptedProvider, call = 1): ToolResultPart[] {
  return (lp.requests[call]?.messages.at(-1)?.parts ?? []) as ToolResultPart[];
}

const edit = { name: 'write', input: { path: 'b.txt', content: 'beta\n' } };
const session = (engine: Engine, mode?: PermissionMode) =>
  engine.createSession(mode ? { permissionMode: mode } : {}).id;

describe('permission modes', () => {
  test('acceptEdits allows edits that would otherwise ask', async () => {
    const { engine, events } = setup([{ toolCalls: [edit] }, { text: 'done' }], { edit: 'ask' });
    await engine.runTurn(session(engine, 'acceptEdits'), 'write it');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('beta\n');
    expect(events.some((e) => e.type === 'permission.requested')).toBe(false);
  });

  test('plan mode refuses edits, and the model is told it is planning', async () => {
    const { engine, lp } = setup([{ toolCalls: [edit] }, { text: 'ok' }], { edit: 'allow' });
    const id = session(engine, 'plan');
    await engine.runTurn(id, 'write it');
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
    expect(results(lp)[0]?.content).toContain('Plan mode is on');
    const prompt = lp.requests[0]?.messages.at(-1)?.parts ?? [];
    expect(
      prompt.some((p) => p.type === 'text' && p.reminder && /Plan mode is on/.test(p.text)),
    ).toBe(true);
    // The reminder is for the model, not the transcript view.
    const { session: summary, messages } = engine.getSession(id);
    const view = fromTranscript(summary, messages);
    expect(
      view.items.filter((i) => i.kind === 'user').map((i) => i.kind === 'user' && i.text),
    ).toEqual(['write it']);
  });

  test('approving the plan leaves plan mode', async () => {
    const { engine, lp, events } = setup(
      [
        { toolCalls: [{ name: 'exit_plan_mode', input: { plan: '1. add b.txt' } }] },
        { toolCalls: [edit] },
        { text: 'done' },
      ],
      { edit: 'allow' },
    );
    engine.subscribe((e) => {
      if (e.type === 'permission.requested' && e.plan)
        engine.respondPermission(e.requestId, 'allow_once');
    });
    const id = session(engine, 'plan');
    await engine.runTurn(id, 'plan then do it');
    expect(events.find((e) => e.type === 'permission.requested')).toMatchObject({
      plan: '1. add b.txt',
    });
    expect(events.find((e) => e.type === 'mode.changed')).toMatchObject({ mode: 'default' });
    expect(results(lp)[0]?.content).toContain('approved');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('beta\n');
    expect(engine.getSession(id).session.permissionMode).toBe('default');
  });

  test('bypass allows everything except deny and ask rules', async () => {
    const calls = [
      { name: 'bash', input: { command: 'echo ok' } },
      { name: 'bash', input: { command: 'git push origin main' } },
      { name: 'bash', input: { command: 'rm -rf build' } },
    ];
    const { engine, lp, events } = setup(
      [{ toolCalls: calls }, { text: 'done' }],
      { bash: 'ask', ask: ['bash(git push:*)'], deny: ['bash(rm:*)'] },
      { interaction: 'deny' },
    );
    await engine.runTurn(session(engine, 'bypassPermissions'), 'go');
    const [echo, push, rm] = results(lp);
    expect(echo?.content).toContain('ok');
    expect(push?.isError).toBe(true); // asked, and the headless run said no
    expect(rm?.content).toContain('Denied by the permission rule bash(rm:*) (config)');
    expect(events.some((e) => e.type === 'permission.requested')).toBe(false);
  });

  test('an organization can rule out bypass', () => {
    const org = {
      id: 'o',
      name: 'Acme',
      version: '1',
      notes: [],
      enforcedKeys: [],
      remoteDisabled: false,
      bypassDisabled: true,
    };
    const { engine } = setup([], {}, { org });
    const id = session(engine);
    expect(() => engine.setMode(id, 'bypassPermissions')).toThrow("Acme's policy doesn't allow");
    expect(engine.permissions(id).modes).not.toContain('bypassPermissions');
  });
});

describe('rules at the prompt', () => {
  test('always grants the rule shown, not the whole category', async () => {
    const { engine, events } = setup(
      [
        { toolCalls: [{ name: 'bash', input: { command: 'git status' } }] },
        { toolCalls: [{ name: 'bash', input: { command: 'git status -s' } }] },
        { toolCalls: [{ name: 'bash', input: { command: 'ls' } }] },
        { text: 'done' },
      ],
      { bash: 'ask' },
    );
    const asked: string[] = [];
    engine.subscribe((e) => {
      if (e.type !== 'permission.requested') return;
      asked.push(e.summary);
      engine.respondPermission(e.requestId, asked.length === 1 ? 'allow_always' : 'deny');
    });
    await engine.runTurn(session(engine), 'go');
    expect(events.find((e) => e.type === 'permission.requested')).toMatchObject({
      rules: ['bash(git status:*)'],
    });
    expect(asked).toEqual(['$ git status', '$ ls']);
    expect(engine.permissions().rules).toContainEqual({
      rule: 'bash(git status:*)',
      behavior: 'allow',
      source: 'this session',
    });
  });

  test('always in this project saves the rule in a personal, git-ignored file', async () => {
    const { engine } = setup(
      [{ toolCalls: [{ name: 'bash', input: { command: 'bun test' } }] }, { text: 'done' }],
      { bash: 'ask' },
    );
    engine.subscribe((e) => {
      if (e.type === 'permission.requested')
        engine.respondPermission(e.requestId, 'allow_always', 'project');
    });
    await engine.runTurn(session(engine), 'go');
    const file = join(root, '.switchback', 'config.local.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).permissions.allow).toEqual(['bash(bun test:*)']);
    expect(readFileSync(join(root, '.switchback', '.gitignore'), 'utf8')).toBe(
      'config.local.json*\n',
    );
  });

  test('read deny rules keep files out of search results', async () => {
    const { engine, lp } = setup(
      [{ toolCalls: [{ name: 'grep', input: { pattern: 'alpha' } }] }, { text: 'done' }],
      { deny: ['read(.env)'] },
    );
    await engine.runTurn(session(engine), 'search');
    const out = results(lp)[0]?.content ?? '';
    expect(out).toContain('a.txt');
    expect(out).not.toContain('.env');
  });
});

describe('config layers', () => {
  test("rules add up across files, and an organization's always apply", () => {
    const home = mkdtempSync(join(tmpdir(), 'switchback-home-'));
    try {
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({ permissions: { allow: ['bash(git:*)'] } }),
      );
      mkdirSync(join(root, '.switchback'));
      writeFileSync(
        join(root, '.switchback', 'config.json'),
        JSON.stringify({ permissions: { deny: ['read(.env)'] } }),
      );
      const policy: OrgPolicy = {
        version: '3',
        org: { id: 'o', name: 'Acme' },
        defaults: {},
        enforced: { permissions: { deny: ['bash(curl:*)'] } },
        restrictions: {
          allowRemote: true,
          allowUserProviders: true,
          allowUserMcpServers: true,
          allowUserPermissionRules: false,
          allowBypassPermissions: true,
        },
        refreshSeconds: 300,
      };
      const loaded = loadConfig(root, { SWITCHBACK_HOME: home }, [], policy);
      expect(loaded.config.permissions.deny).toEqual(['read(.env)', 'bash(curl:*)']);
      expect(loaded.config.permissions.allow).toEqual([]);
      expect(loaded.rules.find((r) => r.rule === 'bash(curl:*)')?.source).toBe('organization');
      expect(loaded.org?.notes).toContain(
        `allow rule "bash(git:*)" from ${join(home, 'config.json')} ignored: only organization rules apply`,
      );
      expect(loaded.rules.find((r) => r.rule === 'read(.env)')?.source).toBe(
        '.switchback/config.json',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a bad rule names itself', () => {
    const r = SwitchbackConfig.safeParse({ permissions: { deny: ['bash()'] } });
    expect(r.error?.issues[0]).toMatchObject({
      path: ['permissions', 'deny'],
      message: 'permission rule "bash()": empty parentheses; leave them out to match every call',
    });
  });
});
