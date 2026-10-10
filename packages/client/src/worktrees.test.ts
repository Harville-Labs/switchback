import { expect, test } from 'bun:test';
import type { WorktreeInfo } from '@switchback/protocol';
import { initialView, reduce } from './view.ts';
import { formatWorktreeDiff, formatWorktrees, worktreeLabel } from './worktrees.ts';

const branch = 'switchback/1a2b3c4d5e6f';

test('a subagent row shows its branch while it runs, then what it left', () => {
  let v = reduce(initialView('s'), {
    type: 'subagent.started',
    sessionId: 's',
    childSessionId: 'c',
    agent: 'general',
    task: 'edit shared',
    worktree: { branch, path: '/data/worktrees/x/1a2b3c4d5e6f' },
  });
  const row = () => v.items.find((i) => i.kind === 'subagent');
  expect(row()).toMatchObject({ worktree: { branch } });
  v = reduce(v, {
    type: 'subagent.completed',
    sessionId: 's',
    childSessionId: 'c',
    agent: 'general',
    ok: true,
    worktree: { branch, changed: true, files: 2, insertions: 40, deletions: 2 },
  });
  expect(row()).toMatchObject({ status: 'ok', worktree: { changed: true, files: 2 } });
});

test('the row label: the branch, its size, or why it was kept', () => {
  expect(worktreeLabel({ branch })).toBe(`⎇ ${branch}`);
  expect(worktreeLabel({ branch, changed: true, files: 1, insertions: 3, deletions: 0 })).toBe(
    `⎇ ${branch} · 1 file +3 −0`,
  );
  expect(worktreeLabel({ branch, changed: false })).toBe('⎇ no changes');
  expect(worktreeLabel({ branch, changed: false, kept: '/wt/x' })).toBe(
    `⎇ ${branch} · kept at /wt/x`,
  );
});

test('/worktrees lists each branch with its state, size, and what it was for', () => {
  const list: WorktreeInfo[] = [
    {
      branch,
      state: 'ready',
      ahead: 1,
      files: 2,
      insertions: 40,
      deletions: 2,
      agent: 'general',
      task: 'edit shared',
    },
    {
      branch: 'switchback/eeeeeeeeeeee',
      state: 'merged',
      ahead: 0,
      files: 0,
      insertions: 0,
      deletions: 0,
    },
    {
      branch: 'switchback/ffffffffffff',
      state: 'kept',
      ahead: 0,
      files: 0,
      insertions: 0,
      deletions: 0,
      path: '/wt/f',
    },
  ];
  expect(formatWorktrees(list)).toBe(
    [
      `⎇ ${branch}  ready to merge · 2 files +40 −2 · 1 commit ahead`,
      '    edit shared (general)',
      '⎇ switchback/eeeeeeeeeeee  merged',
      '⎇ switchback/ffffffffffff  kept after a failure · 0 files +0 −0',
      '    at /wt/f',
      '',
      'See one: /worktrees <branch>. Ask the agent to merge one; it asks you first, with the diff.',
    ].join('\n'),
  );
  expect(formatWorktrees([])).toContain('isolation: worktree');
});

test('a diff reads as its stat, then the patch', () => {
  const d = { branch, base: 'abcdef0123', stat: ' a | 1 +', diff: '+x', files: [] };
  expect(formatWorktreeDiff(d)).toBe(`${branch} since abcdef01\n a | 1 +\n\n+x`);
  expect(formatWorktreeDiff({ ...d, diff: '' })).toBe(`${branch} has no changes from abcdef01.`);
});
