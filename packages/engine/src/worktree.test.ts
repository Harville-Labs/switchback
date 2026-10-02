import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import { type Provider, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';

let repo: string;
let data: string;
const git = (...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'switchback-wt-')));
  data = mkdtempSync(join(tmpdir(), 'switchback-wt-data-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  writeFileSync(join(repo, 'shared.txt'), 'original\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  rmSync(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** The parent starts two isolated editors in parallel; each writes shared.txt and its own file. */
function setup(childFails = false) {
  const tasks = ['one', 'two'].map((n) => ({
    name: 'task',
    input: {
      agent: 'general',
      description: `edit ${n}`,
      prompt: `writer ${n}`,
      isolation: 'worktree',
    },
  }));
  const lp = new ScriptedProvider('lp', 'local', (req) => {
    const first = req.messages[0]?.parts[0];
    const prompt = first?.type === 'text' ? first.text : '';
    const last = req.messages.at(-1);
    const afterTool = last?.parts.some((p) => p.type === 'tool_result');
    const writer = /^writer (\w+)/.exec(prompt)?.[1];
    if (writer) {
      if (afterTool)
        return childFails && writer === 'two'
          ? { text: 'x', stopReason: 'refusal' }
          : { text: `${writer} done` };
      return {
        toolCalls: [
          { name: 'write', input: { path: 'shared.txt', content: `from ${writer}\n` } },
          { name: 'write', input: { path: `${writer}.txt`, content: writer } },
        ],
      };
    }
    return afterTool ? { text: 'parent done' } : { toolCalls: tasks };
  });
  const engine = new Engine({
    workspaceRoot: repo,
    dataDir: data,
    config: SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { local: { provider: 'lp', model: 'm', contextWindow: 100_000 } },
      routing: { start: ['local'], allowRemote: false },
      permissions: { edit: 'allow' },
    }),
    providers: new Map<string, Provider>([['lp', lp]]),
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, lp, events };
}
const worktrees = () => {
  const base = join(data, 'worktrees');
  return existsSync(base) ? readdirSync(base).flatMap((d) => readdirSync(join(base, d))) : [];
};

describe('worktree isolation', () => {
  test('parallel editors never touch the main tree; each branch holds its changes', async () => {
    const { engine, lp } = setup();
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'go');
    expect(r.text).toBe('parent done');

    // Every subagent succeeded (on failure, show what it said).
    const errors = engine
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .filter((p) => p.type === 'tool_result' && p.isError);
    expect(errors).toEqual([]);

    // Main working tree untouched.
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(join(repo, 'one.txt'))).toBe(false);
    expect(git('status', '--porcelain')).toBe('');

    // One branch per subagent, with its own version of the shared file.
    const branches = git('branch', '--list', 'switchback/*', '--format=%(refname:short)').split(
      '\n',
    );
    expect(branches).toHaveLength(2);
    const contents = branches.map((b) => git('show', `${b}:shared.txt`)).sort();
    expect(contents).toEqual(['from one', 'from two']);

    // Cleaned up on success.
    expect(worktrees()).toEqual([]);
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);

    // The parent was told the branch and shown the diff.
    const results = engine
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .filter((p) => p.type === 'tool_result');
    for (const res of results) {
      expect(res.type === 'tool_result' && res.content).toMatch(
        /committed on branch `switchback\/\w+`/,
      );
      expect(res.type === 'tool_result' && res.content).toContain('+from ');
    }
    // Each child's system prompt points at its worktree.
    const childSystems = lp.requests
      .map((q) => q.system)
      .filter((sys) => sys.includes('isolated git worktree'));
    expect(childSystems.length).toBeGreaterThan(0);
  });

  test('a failed subagent keeps its worktree for inspection', async () => {
    const { engine } = setup(true);
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'go');
    expect(worktrees()).toHaveLength(1);
    const failed = engine
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result' && p.isError);
    expect(failed?.type === 'tool_result' && failed.content).toContain('kept for inspection');
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('original\n');
  });

  test('outside a git repository the task fails clearly', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'switchback-nogit-'));
    const lp = new ScriptedProvider('lp', 'local', (req) =>
      req.messages.at(-1)?.parts.some((p) => p.type === 'tool_result')
        ? { text: 'ok' }
        : {
            toolCalls: [
              {
                name: 'task',
                input: { agent: 'general', description: 'x', prompt: 'y', isolation: 'worktree' },
              },
            ],
          },
    );
    const engine = new Engine({
      workspaceRoot: plain,
      dataDir: data,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' } },
        models: { local: { provider: 'lp', model: 'm', contextWindow: 100_000 } },
        routing: { start: ['local'], escalate: [] },
      }),
      providers: new Map<string, Provider>([['lp', lp]]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.runTurn(engine.createSession({}).id, 'go');
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ isError: true });
    expect(
      (events.find((e) => e.type === 'tool.completed') as { output: string }).output,
    ).toContain('needs a git repository');
    rmSync(plain, { recursive: true, force: true });
  });
});
