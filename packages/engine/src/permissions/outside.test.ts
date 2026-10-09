import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, PermissionDecision, ToolResultPart } from '@switchback/protocol';
import { type Provider, type Script, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from '../config.ts';
import { Engine } from '../engine.ts';
import { folderRule, reachOf } from './outside.ts';

let base: string;
let root: string;
let away: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'switchback-outside-')));
  root = join(base, 'repo');
  away = join(base, 'notes');
  mkdirSync(root);
  mkdirSync(away);
  writeFileSync(join(away, 'a.md'), 'alpha\n');
  writeFileSync(join(away, 'b.md'), 'beta\n');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** An engine whose model makes `calls`, one per step; `answer` decides each permission prompt. */
function run(
  calls: { name: string; input: unknown }[],
  config: object = {},
  answer: (e: Extract<EngineEvent, { type: 'permission.requested' }>) => PermissionDecision = () =>
    'allow_once',
) {
  const script: Script = [...calls.map((c) => ({ toolCalls: [c] })), { text: 'done' }];
  const lp = new ScriptedProvider('lp', 'local', script);
  const engine = new Engine({
    workspaceRoot: root,
    userConfigFile: join(base, 'home', 'config.json'),
    config: SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { m: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
      routing: { start: ['m'] },
      ...config,
    }),
    providers: new Map<string, Provider>([['lp', lp]]),
  });
  const asked: Extract<EngineEvent, { type: 'permission.requested' }>[] = [];
  engine.subscribe((e) => {
    if (e.type !== 'permission.requested') return;
    asked.push(e);
    engine.respondPermission(e.requestId, answer(e));
  });
  const results = () =>
    lp.requests
      .flatMap((r) => r.messages.at(-1)?.parts ?? [])
      .filter((p): p is ToolResultPart => p.type === 'tool_result');
  return { engine, asked, results, go: () => engine.runTurn(engine.createSession({}).id, 'go') };
}

describe('outside the workspace', () => {
  test('a read asks, and "always" opens that folder for the rest of the session', async () => {
    const { asked, results, go } = run(
      [
        { name: 'read', input: { path: join(away, 'a.md') } },
        { name: 'read', input: { path: '../notes/b.md' } },
      ],
      {},
      () => 'allow_always',
    );
    await go();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ reason: 'outside the workspace', rules: [`read(/${away}/)`] });
    expect(results().map((r) => r.content)).toEqual([
      expect.stringContaining('alpha'),
      expect.stringContaining('beta'),
    ]);
  });

  test('an allow rule naming the folder opens it; a bare read rule and read: allow do not', async () => {
    const named = run([{ name: 'read', input: { path: join(away, 'a.md') } }], {
      permissions: { allow: [`read(/${away}/)`] },
    });
    await named.go();
    expect(named.asked).toHaveLength(0);

    const bare = run([{ name: 'grep', input: { pattern: 'alpha', path: away } }], {
      permissions: { read: 'allow', allow: ['read'] },
    });
    await bare.go();
    expect(bare.asked).toHaveLength(1);
    expect(bare.asked[0]?.rules).toEqual([`read(/${away}/)`]);
  });

  test('edits ask even in acceptEdits, and a denied write changes nothing', async () => {
    const { asked, results, go } = run(
      [{ name: 'write', input: { path: join(away, 'c.md'), content: 'gamma\n' } }],
      { permissions: { defaultMode: 'acceptEdits' } },
      () => 'deny',
    );
    await go();
    expect(asked[0]).toMatchObject({ tool: 'write', reason: 'outside the workspace' });
    expect(asked[0]?.preview).toContain('+gamma');
    expect(results()[0]?.isError).toBe(true);
    expect(existsSync(join(away, 'c.md'))).toBe(false);
  });

  test('permissions.outsideWorkspace: deny refuses without asking', async () => {
    const { asked, results, go } = run([{ name: 'read', input: { path: join(away, 'a.md') } }], {
      permissions: { outsideWorkspace: 'deny' },
    });
    await go();
    expect(asked).toHaveLength(0);
    expect(results()[0]?.content).toContain('permissions.outsideWorkspace is deny');
  });

  test('credentials are refused in every mode, bypass included', async () => {
    const { asked, results, go } = run([{ name: 'read', input: { path: join(away, 'a.md') } }], {
      permissions: { defaultMode: 'bypassPermissions' },
      bash: { sandbox: { denyRead: [away] } },
    });
    await go();
    expect(asked).toHaveLength(0);
    expect(results()[0]?.content).toContain('is off limits: credentials');
  });

  test('a private folder outside the workspace keeps the session local', async () => {
    const { engine, go } = run([{ name: 'read', input: { path: join(away, 'a.md') } }], {
      privacy: { localOnlyPaths: [`/${away}/`] },
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await go();
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({
      private: `read ${join(away, 'a.md')}`,
    });
  });
});

describe('config edits', () => {
  test('an edit that would break the config fails before anyone is asked', async () => {
    mkdirSync(join(root, '.switchback'));
    writeFileSync(join(root, '.switchback', 'config.json'), '{\n  "maxStepsPerTurn": 40\n}\n');
    const { asked, results, go } = run([
      {
        name: 'edit',
        input: { path: '.switchback/config.json', oldString: '40', newString: '"lots"' },
      },
    ]);
    await go();
    expect(asked).toHaveLength(0);
    expect(results()[0]).toMatchObject({ isError: true });
    expect(results()[0]?.content).toContain('maxStepsPerTurn');
    expect(readFileSync(join(root, '.switchback', 'config.json'), 'utf8')).toContain('40');
  });

  test('a valid edit to your user config asks with its diff', async () => {
    const file = join(base, 'home', 'config.json');
    mkdirSync(join(base, 'home'));
    writeFileSync(file, '{\n  // mine\n  "maxStepsPerTurn": 40\n}\n');
    const { asked, go } = run([
      { name: 'edit', input: { path: file, oldString: '40', newString: '60' } },
    ]);
    await go();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.preview).toContain('+  "maxStepsPerTurn": 60');
    expect(readFileSync(file, 'utf8')).toBe('{\n  // mine\n  "maxStepsPerTurn": 60\n}\n');
  });

  test('a file that is not JSON is reported with its line and column', async () => {
    const file = join(base, 'home', 'config.json');
    const { asked, results, go } = run([
      { name: 'write', input: { path: file, content: '{ "a": ' } },
    ]);
    await go();
    expect(asked).toHaveLength(0);
    expect(results()[0]?.content).toMatch(/line 1, column \d+/);
  });
});

describe('reachOf', () => {
  const places = {
    configDir: '/h/.switchback',
    dataDir: '/h/.switchback/data',
    denyRead: ['~/.ssh'],
    home: '/h',
  };
  test("Switchback's data and sign-in are off limits; its config asks; elsewhere is outside", () => {
    expect(reachOf('/h/.switchback/data/usage.jsonl', false, places)).toMatchObject({
      kind: 'off-limits',
    });
    expect(reachOf('/h/.switchback/auth.json', false, places)).toMatchObject({
      kind: 'off-limits',
    });
    expect(reachOf('/h/.ssh/id_ed25519', false, places)).toMatchObject({ kind: 'off-limits' });
    expect(reachOf('/h/.switchback/config.json', false, places)).toMatchObject({
      kind: 'switchback',
    });
    expect(reachOf('/h/notes/a.md', false, places)).toMatchObject({ kind: 'outside' });
    expect(reachOf('/h/repo/a.ts', true, places)).toEqual({ kind: 'inside' });
    // A credential is off limits even when the workspace holds it.
    expect(reachOf('/h/.ssh/config', true, places)).toMatchObject({ kind: 'off-limits' });
  });

  test('"always" names the folder from home or from the root', () => {
    expect(folderRule('read', '/h/notes/a.md', false, '/h')).toBe('read(~/notes/)');
    expect(folderRule('edit', '/srv/data', true, '/h')).toBe('edit(//srv/data/)');
  });
});
