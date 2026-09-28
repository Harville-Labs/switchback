/**
 * Git worktree isolation for subagents that edit files. Each isolated
 * subagent works in its own worktree on its own branch, so parallel editors
 * never touch each other or the user's working tree. On success the changes
 * are committed to the branch and the worktree is removed; the parent gets
 * the branch name and diff and decides whether to merge. On failure the
 * worktree is kept for inspection.
 */
import { mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Worktree {
  /** The repository's top-level directory. */
  repo: string;
  /** Worktree checkout. */
  path: string;
  /** The workspace root inside the worktree (the workspace may be a subdirectory of the repo). */
  root: string;
  branch: string;
  /** Commit the worktree started from. */
  base: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  // An argument array, never a shell string: branch names and paths are not interpreted.
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim() || out.trim()}`);
  return out.trim();
}

/**
 * Operations on a repository's shared state (worktree list, branches, config)
 * take git's locks; parallel subagents would collide on them (seen on
 * Windows), so they run one at a time per repository.
 */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(repo: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(repo) ?? Promise.resolve()).then(work, work);
  queues.set(
    repo,
    run.catch(() => undefined),
  );
  return run;
}

export async function gitToplevel(dir: string): Promise<string | undefined> {
  return git(dir, ['rev-parse', '--show-toplevel']).catch(() => undefined);
}

/** Create a worktree on a new branch from HEAD. Throws with a clear message outside a git repo. */
export async function createWorktree(
  workspaceRoot: string,
  baseDir: string,
  id: string,
): Promise<Worktree> {
  const repo = await gitToplevel(workspaceRoot);
  if (!repo)
    throw new Error('worktree isolation needs a git repository; this workspace is not one');
  const base = await git(repo, ['rev-parse', 'HEAD']).catch(() => {
    throw new Error('worktree isolation needs at least one commit in the repository');
  });
  mkdirSync(baseDir, { recursive: true });
  const path = join(baseDir, id);
  const branch = `harness/${id}`;
  await serialized(repo, () => git(repo, ['worktree', 'add', '-b', branch, path, base]));
  return { repo, path, root: join(path, relative(repo, workspaceRoot)), branch, base };
}

export interface WorktreeResult {
  changed: boolean;
  /** `git diff --stat` against the base. */
  stat: string;
  /** Full diff, for the parent to review (may be long; callers truncate). */
  diff: string;
}

/**
 * Commit whatever the subagent changed to its branch, then remove the
 * worktree. With no changes the branch is deleted too.
 */
export async function finishWorktree(wt: Worktree, message: string): Promise<WorktreeResult> {
  await git(wt.path, ['add', '-A']);
  const staged = await git(wt.path, ['diff', '--cached', '--name-only']);
  if (staged) {
    // Use the user's identity when set; otherwise a neutral one, so the commit never fails.
    const named = await git(wt.path, ['config', 'user.email']).catch(() => '');
    await git(wt.path, [
      ...(named ? [] : ['-c', 'user.name=Harness', '-c', 'user.email=harness@localhost']),
      'commit',
      '--no-verify',
      '-m',
      message,
    ]);
  }
  const stat = staged ? await git(wt.path, ['diff', '--stat', wt.base, 'HEAD']) : '';
  const diff = staged ? await git(wt.path, ['diff', wt.base, 'HEAD']) : '';
  await serialized(wt.repo, async () => {
    await git(wt.repo, ['worktree', 'remove', '--force', wt.path]);
    if (!staged) await git(wt.repo, ['branch', '-D', wt.branch]).catch(() => undefined);
  });
  return { changed: !!staged, stat, diff };
}
