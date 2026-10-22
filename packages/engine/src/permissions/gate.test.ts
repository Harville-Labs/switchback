import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, SwitchbackConfig } from '../config.ts';
import type { OrgPolicy } from '../org/policy.ts';
import { edit, results, root, session, setup, useWorkspace } from './gate-fixture.ts';

useWorkspace();

describe('permission levels', () => {
  test('web set to deny turns search off too, though search is allowed on its own', async () => {
    const search = { name: 'websearch', input: { query: 'bun test' } };
    const { engine, lp } = setup([{ toolCalls: [search] }, { text: 'ok' }], { web: 'deny' });
    await engine.runTurn(session(engine), 'look it up');
    expect(results(lp)[0]?.content).toContain('permissions.web is deny');
  });

  test('auto lets a call through when the judge approves it', async () => {
    const approve = { text: 'Sure. {"approve": true, "reason": "the user asked for b.txt"}' };
    const { engine, lp, events } = setup([{ toolCalls: [edit] }, approve, { text: 'done' }], {
      edit: 'ask',
    });
    await engine.runTurn(session(engine, 'auto'), 'write b.txt');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('beta\n');
    expect(events.some((e) => e.type === 'permission.requested')).toBe(false);
    expect(events.find((e) => e.type === 'permission.judged')).toMatchObject({
      tool: 'write',
      approved: true,
      reason: 'the user asked for b.txt',
      judge: 'local',
    });
    // The judge sees the user's words and the call, not the whole transcript.
    const judged = lp.requests[1];
    expect(judged?.tools).toEqual([]);
    const asked = judged?.messages[0]?.parts[0];
    expect(asked?.type === 'text' && asked.text).toContain('The user asked:\nwrite b.txt');
  });

  test('auto asks the user about anything the judge refuses', async () => {
    const push = { name: 'bash', input: { command: 'git push origin main' } };
    const refuse = { text: '{"approve": false, "reason": "pushing publishes the branch"}' };
    const { engine, events } = setup([{ toolCalls: [push] }, refuse, { text: 'ok' }], {
      bash: 'ask',
    });
    engine.subscribe((e) => {
      if (e.type === 'permission.requested') engine.respondPermission(e.requestId, 'deny');
    });
    await engine.runTurn(session(engine, 'auto'), 'fix the test');
    expect(events.find((e) => e.type === 'permission.requested')).toMatchObject({
      reason: 'not auto-approved: pushing publishes the branch',
    });
  });

  test('auto asks when the judge answers with something unreadable', async () => {
    const { engine, events } = setup(
      [{ toolCalls: [edit] }, { text: 'yes, go ahead' }, { text: 'ok' }],
      { edit: 'ask' },
    );
    engine.subscribe((e) => {
      if (e.type === 'permission.requested') engine.respondPermission(e.requestId, 'deny');
    });
    await engine.runTurn(session(engine, 'auto'), 'write it');
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
    expect(events.find((e) => e.type === 'permission.requested')).toMatchObject({
      reason: "not auto-approved: the judge's answer wasn't readable",
    });
  });

  test('auto still asks for ask rules without calling the judge', async () => {
    const push = { name: 'bash', input: { command: 'git push origin main' } };
    const { engine, lp } = setup(
      [{ toolCalls: [push] }, { text: 'ok' }],
      { bash: 'allow', ask: ['bash(git push:*)'] },
      { interaction: 'deny' },
    );
    await engine.runTurn(session(engine, 'auto'), 'push it');
    expect(lp.requests).toHaveLength(2);
    expect(results(lp)[0]?.isError).toBe(true);
  });

  test('bypass allows everything except deny rules, without asking', async () => {
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
    await engine.runTurn(session(engine, 'bypass'), 'go');
    const [echo, push, rm] = results(lp);
    expect(echo?.content).toContain('ok');
    expect(push?.isError).toBeFalsy(); // the ask rule doesn't hold in bypass
    expect(rm?.content).toContain('Denied by the permission rule bash(rm:*) (config)');
    expect(events.some((e) => e.type === 'permission.requested')).toBe(false);
  });

  test('an organization can rule out bypass', async () => {
    const org = {
      id: 'o',
      name: 'Acme',
      version: '1',
      notes: [],
      enforcedKeys: [],
      remoteDisabled: false,
      bypassDisabled: true,
      userPermissionsDisabled: false,
    };
    const { engine } = setup([], {}, { org });
    const id = session(engine);
    expect(() => engine.setPermissions(id, 'bypass')).toThrow("Acme's policy doesn't allow");
    expect((await engine.permissions(id)).allowedLevels).not.toContain('bypass');
  });
});

describe('exploring with bash', () => {
  const run = (command: string) => ({ toolCalls: [{ name: 'bash', input: { command } }] });

  test('read-only commands in the workspace run without asking', async () => {
    const { engine, lp, events } = setup(
      [run('cd . && ls && grep -n alpha a.txt && git status'), { text: 'done' }],
      { bash: 'ask' },
    );
    await engine.runTurn(session(engine), 'look around');
    expect(events.some((e) => e.type === 'permission.requested')).toBe(false);
    expect(results(lp)[0]?.content).toContain('alpha');
  });

  test('reaching outside the workspace, a guarded file, or permissions.read ask still asks', async () => {
    const cases: [string, object][] = [
      ['cat ../outside.txt', { bash: 'ask' }],
      ['cat .env', { bash: 'ask', deny: ['read(.env)'] }],
      ['grep -rn TOKEN .', { bash: 'ask', ask: ['read(.env)'] }],
      ['ls', { bash: 'ask', read: 'ask' }],
    ];
    for (const [command, permissions] of cases) {
      // With prompts denied, a call that asks comes back refused.
      const { engine, lp } = setup([run(command), { text: 'ok' }], permissions, {
        interaction: 'deny',
      });
      await engine.runTurn(session(engine), 'go');
      expect({ command, refused: results(lp)[0]?.isError }).toEqual({ command, refused: true });
    }
  });
});

describe('rules at the prompt', () => {
  test('always grants the rule shown, not the whole category', async () => {
    const { engine, events } = setup(
      [
        { toolCalls: [{ name: 'bash', input: { command: 'git add a.txt' } }] },
        { toolCalls: [{ name: 'bash', input: { command: 'git add -A' } }] },
        { toolCalls: [{ name: 'bash', input: { command: 'printf x' } }] },
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
      rules: ['bash(git add:*)'],
    });
    expect(asked).toEqual(['$ git add a.txt', '$ printf x']);
    expect((await engine.permissions()).rules).toContainEqual({
      rule: 'bash(git add:*)',
      behavior: 'allow',
      source: 'this session',
    });
  });

  test('a denial can tell the model what to do instead', async () => {
    const { engine, lp } = setup(
      [{ toolCalls: [{ name: 'bash', input: { command: 'make deploy' } }] }, { text: 'ok' }],
      { bash: 'ask' },
    );
    engine.subscribe((e) => {
      if (e.type === 'permission.requested')
        engine.respondPermission(e.requestId, 'deny', undefined, 'run make test first');
    });
    await engine.runTurn(session(engine), 'go');
    const [result] = results(lp);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain('run make test first');
  });

  test('no always when the organization sets everyone permissions', async () => {
    const org = {
      id: 'o',
      name: 'Acme',
      version: '1',
      notes: [],
      enforcedKeys: [],
      remoteDisabled: false,
      bypassDisabled: false,
      userPermissionsDisabled: true,
    };
    // `printf`, not a build tool: on macOS `/usr/bin/make` is an xcrun shim that can take
    // seconds on a cold machine, and only the asking matters here.
    const { engine, events } = setup(
      [
        { toolCalls: [{ name: 'bash', input: { command: 'printf hi' } }] },
        { toolCalls: [{ name: 'bash', input: { command: 'printf hi' } }] },
        { text: 'done' },
      ],
      { bash: 'ask' },
      { org },
    );
    engine.subscribe((e) => {
      if (e.type === 'permission.requested') engine.respondPermission(e.requestId, 'allow_always');
    });
    await engine.runTurn(session(engine), 'go');
    const asked = events.filter((e) => e.type === 'permission.requested');
    expect(asked).toHaveLength(2);
    expect(asked[0]).not.toHaveProperty('rules');
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
          allowUserPermissions: false,
          allowUserHooks: true,
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
