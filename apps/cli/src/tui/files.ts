/** Workspace file list for @-mention completion. git-aware, cached briefly. */
import { Glob } from 'bun';

const IGNORED = /(^|\/)(node_modules|\.git|dist|\.tsbuild|\.next|target|\.venv)(\/|$)/;
const LIMIT = 20_000;
const TTL_MS = 30_000;

let cache: { root: string; at: number; files: string[] } | undefined;

export async function workspaceFiles(root: string): Promise<string[]> {
  if (cache && cache.root === root && Date.now() - cache.at < TTL_MS) return cache.files;
  let files = gitFiles(root);
  if (!files) {
    files = [];
    for await (const f of new Glob('**/*').scan({ cwd: root, onlyFiles: true })) {
      if (IGNORED.test(f)) continue;
      files.push(f);
      if (files.length >= LIMIT) break;
    }
  }
  files.sort((a, b) => a.length - b.length || a.localeCompare(b));
  cache = { root, at: Date.now(), files };
  return files;
}

/** Tracked plus untracked-but-not-ignored files, or undefined outside a git repo. */
function gitFiles(root: string): string[] | undefined {
  try {
    const proc = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (proc.exitCode !== 0) return undefined;
    return proc.stdout.toString().split('\n').filter(Boolean).slice(0, LIMIT);
  } catch {
    return undefined;
  }
}
