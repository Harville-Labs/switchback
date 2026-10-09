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
import { join, resolve, sep } from 'node:path';
import type { EngineEvent, PermissionDecision, ToolResultPart } from '@switchback/protocol';
import { type Provider, type Script, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from '../config.ts';
import { Engine } from '../engine.ts';
import { folderRule, reachOf } from './outside.ts';
import { pathMatcher } from './path-match.ts';

/** A path as a rule writes it from the root: `//srv/data`, or `//C:/data` on Windows. */
const absolute = (p: string) => `//${p.split(sep).join('/').replace(/^\/+/, '')}`;
const rule = (kind: string, dir: string) => `${kind}(${absolute(dir)}/)`;

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
  test('reads and searches run without asking, as reads in the workspace do', async () => {
    const { asked, results, go } = run([
      { name: 'read', input: { path: join(away, 'a.md') } },
      { name: 'grep', input: { pattern: 'beta', path: '../notes' } },
    ]);
    await go();
    expect(asked).toHaveLength(0);
    expect(results().map((r) => r.content)).toEqual([
      expect.stringContaining('alpha'),
      expect.stringContaining('beta'),
    ]);
  });

  test('an edit asks, and "always" opens that folder for edits', async () => {
    const { asked, go } = run(
      [
        { name: 'write', input: { path: join(away, 'c.md'), content: 'gamma\n' } },
        { name: 'write', input: { path: '../notes/d.md', content: 'delta\n' } },
      ],
      {},
      () => 'allow_always',
    );
    await go();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      reason: 'outside the workspace',
      rules: [rule('edit', away)],
    });
    expect(readFileSync(join(away, 'd.md'), 'utf8')).toBe('delta\n');
  });

  test('an allow rule naming the folder opens it for edits; edit: allow and a bare rule do not', async () => {
    const named = run([{ name: 'write', input: { path: join(away, 'c.md'), content: 'x' } }], {
      permissions: { allow: [rule('edit', away)] },
    });
    await named.go();
    expect(named.asked).toHaveLength(0);

    const bare = run([{ name: 'write', input: { path: join(away, 'c.md'), content: 'x' } }], {
      permissions: { edit: 'allow', allow: ['edit'] },
    });
    await bare.go();
    expect(bare.asked).toHaveLength(1);
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

  test('permissions.outsideWorkspace: deny refuses reads too, without asking', async () => {
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
      privacy: { localOnlyPaths: [`${absolute(away)}/`] },
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
  const H = resolve('/h');
  const places = {
    configDir: join(H, '.switchback'),
    dataDir: join(H, '.switchback', 'data'),
    denyRead: ['~/.ssh'],
    home: H,
  };
  const at = (...p: string[]) => join(H, ...p);
  test("Switchback's data and sign-in are off limits; its config asks; elsewhere is outside", () => {
    expect(reachOf(at('.switchback', 'data', 'usage.jsonl'), false, places)).toMatchObject({
      kind: 'off-limits',
    });
    expect(reachOf(at('.switchback', 'auth.json'), false, places)).toMatchObject({
      kind: 'off-limits',
    });
    expect(reachOf(at('.ssh', 'id_ed25519'), false, places)).toMatchObject({ kind: 'off-limits' });
    expect(reachOf(at('.switchback', 'config.json'), false, places)).toMatchObject({
      kind: 'switchback',
    });
    expect(reachOf(at('notes', 'a.md'), false, places)).toMatchObject({ kind: 'outside' });
    expect(reachOf(at('repo', 'a.ts'), true, places)).toEqual({ kind: 'inside' });
    // A credential is off limits even when the workspace holds it.
    expect(reachOf(at('.ssh', 'config'), true, places)).toMatchObject({ kind: 'off-limits' });
    // A subagent's worktree lives in the data directory; it's that session's own root.
    expect(reachOf(at('.switchback', 'data', 'worktrees', 'w1', 'a.ts'), true, places)).toEqual({
      kind: 'inside',
    });
  });

  test('"always" names the folder from home, or from the root', () => {
    expect(folderRule(at('notes', 'a.md'), H)).toBe('edit(~/notes/)');
    const srv = join(resolve('/srv'), 'data');
    expect(folderRule(join(srv, 'x.csv'), H)).toBe(`edit(${absolute(srv)}/)`);
    if (sep === '/') expect(folderRule('/srv/data/x.csv', H)).toBe('edit(//srv/data/)');
  });

  test('// rules match drive paths on Windows', () => {
    expect(pathMatcher('//C:/data/', '/repo')('C:/data/x.csv')).toBe(true);
    expect(pathMatcher('//C:/data/', '/repo')('D:/data/x.csv')).toBe(false);
  });
});
