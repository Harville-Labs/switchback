/**
 * What isolated subagents left behind, for people to see and review: every
 * `switchback/*` branch in the repository, what it was for, how far it is
 * ahead of your branch, and its diff; and merging one into your working tree
 * (the `merge_worktree` tool, which always asks).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeDiff, WorktreeInfo } from '@switchback/protocol';
import { git, serialized } from './worktree.ts';

/** Who made a branch and why, written when its worktree is created. */
export interface BranchMeta {
  branch: string;
  agent: string;
  task: string;
  sessionId: string;
  parentSessionId: string;
  createdAt: string;
}

export const BRANCH_PREFIX = 'switchback/';

const metaFile = (dir: string, branch: string) =>
  join(dir, 'meta', `${branch.slice(BRANCH_PREFIX.length)}.json`);

/** One file per branch, so parallel subagents (and engines) never write the same file. */
export function writeBranchMeta(dir: string, meta: BranchMeta): void {
  mkdirSync(join(dir, 'meta'), { recursive: true });
  writeFileSync(metaFile(dir, meta.branch), `${JSON.stringify(meta, null, 2)}\n`);
}

function readBranchMeta(dir: string): Map<string, BranchMeta> {
  const out = new Map<string, BranchMeta>();
  const metaDir = join(dir, 'meta');
  if (!existsSync(metaDir)) return out;
  for (const name of readdirSync(metaDir)) {
    try {
      const meta = JSON.parse(readFileSync(join(metaDir, name), 'utf8')) as BranchMeta;
      out.set(meta.branch, meta);
    } catch {
      // A half-written or hand-edited file: the branch is still listed, without its description.
    }
  }
  return out;
}

/** Branch → checkout path, from `git worktree list --porcelain`. */
async function checkouts(repo: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let path = '';
  for (const line of (await git(repo, ['worktree', 'list', '--porcelain'])).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/'))
      out.set(line.slice('branch refs/heads/'.length), path);
  }
  return out;
}

/** `3 files changed, 40 insertions(+), 2 deletions(-)` as numbers. */
export function parseShortstat(line: string): {
  files: number;
  insertions: number;
  deletions: number;
} {
  const n = (re: RegExp) => Number(re.exec(line)?.[1] ?? 0);
  return {
    files: n(/(\d+) files? changed/),
    insertions: n(/(\d+) insertions?\(\+\)/),
    deletions: n(/(\d+) deletions?\(-\)/),
  };
}

/**
 * Every `switchback/*` branch, newest first. `running` names the branches
 * of subagents still working.
 */
export async function listWorktrees(
  repo: string,
  metaDir: string,
  running: Set<string>,
): Promise<WorktreeInfo[]> {
  const refs = await git(repo, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)',
    `refs/heads/${BRANCH_PREFIX}`,
  ]);
  const branches = refs ? refs.split('\n') : [];
  const meta = readBranchMeta(metaDir);
  const out = await checkouts(repo);
  const list: WorktreeInfo[] = [];
  for (const branch of branches) {
    const ahead = Number(await git(repo, ['rev-list', '--count', `HEAD..${branch}`]));
    const base = await git(repo, ['merge-base', 'HEAD', branch]);
    const stat = parseShortstat(await git(repo, ['diff', '--shortstat', base, branch]));
    const path = out.get(branch);
    const m = meta.get(branch);
    list.push({
      branch,
      state: running.has(branch) ? 'running' : path ? 'kept' : ahead ? 'ready' : 'merged',
      ahead,
      ...stat,
      ...(path ? { path } : {}),
      ...(m
        ? { agent: m.agent, task: m.task, sessionId: m.sessionId, createdAt: m.createdAt }
        : {}),
    });
  }
  return list;
}

/** Files larger than this come without their contents (the diff still covers them). */
const MAX_FILE_BYTES = 512_000;

async function show(repo: string, ref: string, path: string): Promise<string | undefined> {
  const text = await git(repo, ['show', `${ref}:${path}`]).catch(() => undefined);
  return text !== undefined && text.length <= MAX_FILE_BYTES ? text : undefined;
}

/** A branch's changes since it left your branch: the diff, and each file before and after. */
export async function worktreeDiff(repo: string, branch: string): Promise<WorktreeDiff> {
  const base = await git(repo, ['merge-base', 'HEAD', branch]);
  const [stat, diff, names] = await Promise.all([
    git(repo, ['diff', '--stat', base, branch]),
    git(repo, ['diff', base, branch]),
    git(repo, ['diff', '--name-status', '--no-renames', base, branch]),
  ]);
  const files: WorktreeDiff['files'] = [];
  for (const line of names ? names.split('\n') : []) {
    const [code = '', path = ''] = line.split('\t');
    const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    const [before, after] = await Promise.all([
      status === 'added' ? undefined : show(repo, base, path),
      status === 'deleted' ? undefined : show(repo, branch, path),
    ]);
    files.push({
      path,
      status,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  }
  return { branch, base, stat, diff, files };
}

/** Why a branch can't be merged right now, or undefined: checked before asking, and again before merging. */
export async function mergeBlocker(repo: string, branch: string): Promise<string | undefined> {
  const path = (await checkouts(repo)).get(branch);
  if (path)
    return `${branch} is still checked out at ${path} (its subagent is running, or failed and was kept). Wait for it, or remove that worktree first.`;
  if (await git(repo, ['status', '--porcelain', '--untracked-files=no']))
    return 'the working tree has uncommitted changes; commit or stash them first, so the merge stays separate from that work';
  return undefined;
}

/**
 * Merge a branch into the checked-out branch, as its own merge commit. Your
 * uncommitted changes are never mixed in: a dirty working tree is refused.
 * A conflict aborts the merge and names the files. Throws with what to do.
 */
export async function mergeWorktree(repo: string, branch: string): Promise<string> {
  const blocked = await mergeBlocker(repo, branch);
  if (blocked) throw new Error(blocked);
  if (!Number(await git(repo, ['rev-list', '--count', `HEAD..${branch}`])))
    return `${branch} is already merged; nothing to do.`;
  const stat = await git(repo, ['diff', '--shortstat', 'HEAD...' + branch]);
  return serialized(repo, async () => {
    const named = await git(repo, ['config', 'user.email']).catch(() => '');
    const identity = named
      ? []
      : ['-c', 'user.name=Switchback', '-c', 'user.email=switchback@localhost'];
    try {
      await git(repo, [...identity, 'merge', '--no-ff', '--no-edit', branch]);
    } catch (err) {
      const conflicts = await git(repo, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
      await git(repo, ['merge', '--abort']).catch(() => undefined);
      if (conflicts)
        throw new Error(
          `merging ${branch} conflicts in ${conflicts.split('\n').join(', ')}; the merge was aborted and nothing changed. Resolve it by hand (git merge ${branch}), or ask for the work to be redone on your current branch.`,
        );
      throw err;
    }
    return `Merged ${branch} into your current branch (${stat.trim()}).`;
  });
}
