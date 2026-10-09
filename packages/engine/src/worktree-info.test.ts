import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchbackClient } from '@switchback/client';
import {
  createTransportPair,
  type EngineEvent,
  type PermissionDecision,
  type ToolResultPart,
} from '@switchback/protocol';
import { type Provider, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { serve } from './server.ts';

let repo: string;
let data: string;
const git = (...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'switchback-wtinfo-')));
  data = mkdtempSync(join(tmpdir(), 'switchback-wtinfo-data-'));
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

/**
 * "isolate": the parent starts one isolated writer (which fails if `fails`).
 * "merge <branch>": the parent merges that branch.
 */
function setup(answer: PermissionDecision = 'allow_once', fails = false) {
  const lp = new ScriptedProvider('lp', 'local', (req) => {
    const text = (i: number) => {
      const part = req.messages.at(i)?.parts[0];
      return part?.type === 'text' ? part.text : '';
    };
    const said = text(-1);
    const afterTool = req.messages.at(-1)?.parts.some((p) => p.type === 'tool_result');
    // The subagent's session starts with its brief.
    if (text(0) === 'write it') {
      if (afterTool) return fails ? { text: 'x', stopReason: 'refusal' } : { text: 'written' };
      return {
        toolCalls: [
          { name: 'write', input: { path: 'shared.txt', content: 'from the agent\n' } },
          { name: 'write', input: { path: 'new.txt', content: 'new\n' } },
        ],
      };
    }
    if (afterTool) return { text: 'parent done' };
    if (said === 'isolate')
      return {
        toolCalls: [
          {
            name: 'task',
            input: {
              agent: 'general',
              description: 'edit shared',
              prompt: 'write it',
              isolation: 'worktree',
            },
          },
        ],
      };
    const branch = /^merge (\S+)$/.exec(said)?.[1];
    return branch ? { toolCalls: [{ name: 'merge_worktree', input: { branch } }] } : { text: '?' };
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
  engine.subscribe((e) => {
    events.push(e);
    if (e.type === 'permission.requested') engine.respondPermission(e.requestId, answer);
  });
  const session = engine.createSession({}).id;
  const say = (text: string) => engine.runTurn(session, text);
  const lastResult = () =>
    (engine.getSession(session).messages.at(-2)?.parts ?? []).find(
      (p): p is ToolResultPart => p.type === 'tool_result',
    );
  return { engine, events, say, lastResult };
}

const asked = (events: EngineEvent[]) =>
  events.filter(
    (e): e is Extract<EngineEvent, { type: 'permission.requested' }> =>
      e.type === 'permission.requested',
  );

test('clients see the branch while it runs and what it left; the list and diff say the same', async () => {
  const { engine, events, say } = setup();
  await say('isolate');
  const started = events.find((e) => e.type === 'subagent.started');
  const completed = events.find((e) => e.type === 'subagent.completed');
  const branch = started?.type === 'subagent.started' ? started.worktree?.branch : undefined;
  expect(branch).toMatch(/^switchback\/[a-z0-9]{12}$/);
  expect(completed).toMatchObject({
    ok: true,
    worktree: { branch, changed: true, files: 2, insertions: 2, deletions: 1 },
  });

  expect(await engine.listWorktrees()).toEqual([
    expect.objectContaining({
      branch,
      state: 'ready',
      ahead: 1,
      files: 2,
      insertions: 2,
      deletions: 1,
      agent: 'general',
      task: 'edit shared',
    }),
  ]);
  const diff = await engine.worktreeDiff(branch as string);
  expect(diff.stat).toContain('2 files changed');
  expect(diff.files).toEqual([
    { path: 'new.txt', status: 'added', after: 'new' },
    { path: 'shared.txt', status: 'modified', before: 'original', after: 'from the agent' },
  ]);
});

test('merging always asks with the diff, then lands as one merge commit', async () => {
  const { engine, events, say, lastResult } = setup();
  await say('isolate');
  const [wt] = await engine.listWorktrees();
  await say(`merge ${wt?.branch}`);
  const [prompt] = asked(events);
  expect(prompt).toMatchObject({
    tool: 'merge_worktree',
    reason: 'merging a branch into your working tree',
  });
  expect(prompt?.preview).toContain('+from the agent');
  expect(prompt).not.toHaveProperty('rules');
  expect(lastResult()?.content).toContain(`Merged ${wt?.branch}`);
  expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('from the agent\n');
  expect(git('log', '-1', '--format=%P').split(' ')).toHaveLength(2);
  expect((await engine.listWorktrees())[0]).toMatchObject({ state: 'merged', ahead: 0 });
});

test('a declined merge changes nothing', async () => {
  const { engine, say } = setup('deny');
  await say('isolate');
  const [wt] = await engine.listWorktrees();
  const head = git('rev-parse', 'HEAD');
  await say(`merge ${wt?.branch}`);
  expect(git('rev-parse', 'HEAD')).toBe(head);
});

test('uncommitted work is never mixed in: the merge is refused before asking', async () => {
  const { engine, events, say, lastResult } = setup();
  await say('isolate');
  const [wt] = await engine.listWorktrees();
  writeFileSync(join(repo, 'shared.txt'), 'my work in progress\n');
  await say(`merge ${wt?.branch}`);
  expect(asked(events)).toHaveLength(0);
  expect(lastResult()).toMatchObject({ isError: true });
  expect(lastResult()?.content).toContain('uncommitted changes');
  expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('my work in progress\n');
});

test('a conflict aborts the merge, names the files, and leaves the tree as it was', async () => {
  const { engine, say, lastResult } = setup();
  await say('isolate');
  const [wt] = await engine.listWorktrees();
  writeFileSync(join(repo, 'shared.txt'), 'mine\n');
  git('commit', '-qam', 'mine');
  await say(`merge ${wt?.branch}`);
  expect(lastResult()?.content).toContain('conflicts in shared.txt; the merge was aborted');
  expect(git('status', '--porcelain')).toBe('');
  expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('mine\n');
});

test('a failed subagent’s worktree is listed as kept, and can’t be merged until it’s removed', async () => {
  const { engine, events, say, lastResult } = setup('allow_once', true);
  await say('isolate');
  const [wt] = await engine.listWorktrees();
  expect(wt).toMatchObject({ state: 'kept', path: expect.stringContaining('worktrees') });
  expect(events.find((e) => e.type === 'subagent.completed')).toMatchObject({
    ok: false,
    worktree: { changed: false, kept: wt?.path },
  });
  await say(`merge ${wt?.branch}`);
  expect(asked(events)).toHaveLength(0);
  expect(lastResult()?.content).toContain('is still checked out');
});

test('worktrees.list and worktrees.diff over the protocol; only Switchback branches', async () => {
  const { engine, say } = setup();
  await say('isolate');
  const [server, client] = createTransportPair();
  serve(engine, server);
  const c = new SwitchbackClient(client);
  await c.initialize({ name: 't', version: '0' }, repo);
  const [wt] = await c.request('worktrees.list', {});
  expect(wt?.state).toBe('ready');
  expect((await c.request('worktrees.diff', { branch: wt?.branch as string })).files).toHaveLength(
    2,
  );
  await expect(c.request('worktrees.diff', { branch: 'main' })).rejects.toThrow(
    'a branch Switchback made for a subagent',
  );
});
