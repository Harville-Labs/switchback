/**
 * What a turn changed in a git workspace, however it changed it: edit and
 * write, shell commands, formatters, commits, merged subagent branches. The
 * working tree is recorded as a git tree when the turn starts and again at
 * review time, and the two are compared. Files the user had already changed
 * before the turn compare equal unless the turn touched them, so they drop out.
 *
 * Snapshots go through a temporary index: the user's index, refs, and stash
 * are never touched. Git stores the snapshot's new blobs as loose objects,
 * which its garbage collection removes later.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { FileChange } from './review.ts';
import { git } from './worktree.ts';

/** Past this many files, the rest are counted, not read: the diff is capped anyway. */
const MAX_FILES = 200;

/** The workspace as a git tree; undefined outside a git repository or mid-merge. */
export async function snapshotWorkspace(root: string): Promise<string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'switchback-snapshot-'));
  try {
    const index = await git(root, ['rev-parse', '--git-path', 'index']);
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    // From a copy of the real index, git rehashes only files whose stat changed.
    const real = isAbsolute(index) ? index : join(root, index);
    if (existsSync(real)) copyFileSync(real, env.GIT_INDEX_FILE);
    await git(root, ['add', '-A', '--', '.'], { env });
    return await git(root, ['write-tree'], { env });
  } catch {
    return undefined; // review falls back to the files edit and write recorded
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Files that differ between the `base` snapshot and the workspace now, with
 * paths relative to `root`; `more` counts files past the cap.
 */
export async function changesSince(
  root: string,
  base: string,
): Promise<{ files: FileChange[]; more: number }> {
  const now = await snapshotWorkspace(root);
  if (!now || now === base) return { files: [], more: 0 };
  const prefix = await git(root, ['rev-parse', '--show-prefix']);
  const numstat = await git(
    root,
    ['diff', '--numstat', '-z', '--no-renames', '--relative', base, now],
    { raw: true },
  );
  // `added\tdeleted\tpath\0` per file; a binary file counts `-\t-`.
  const entries = numstat.split('\0').filter(Boolean);
  const blob = (tree: string, path: string) =>
    git(root, ['cat-file', 'blob', `${tree}:${prefix}${path}`], { raw: true }).catch(
      () => undefined, // not in that tree: the file was created or deleted
    );
  const files: FileChange[] = [];
  // One file at a time: a turn that touched hundreds of files shouldn't start hundreds of gits.
  for (const entry of entries.slice(0, MAX_FILES)) {
    const [added, , ...name] = entry.split('\t');
    const path = name.join('\t');
    if (added === '-') files.push({ path, before: undefined, after: undefined, binary: true });
    else files.push({ path, before: await blob(base, path), after: await blob(now, path) });
  }
  return { files, more: Math.max(0, entries.length - MAX_FILES) };
}
