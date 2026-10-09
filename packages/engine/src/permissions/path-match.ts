/**
 * Path specifiers for `read(...)` and `edit(...)` rules, gitignore-style:
 *
 * - `src/**`, `./docs/*.md`: relative to the workspace root
 * - `.env`, `*.pem` (no slash): that name at any depth
 * - `/build/**`: anchored at the workspace root
 * - `~/.ssh/**`, `//etc/hosts`: absolute paths (home directory, filesystem root;
 *   `//C:/data` on Windows)
 * - a trailing `/` means everything under that directory
 */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Glob } from 'bun';
import { resolveFile } from '../tools/tool.ts';

export type PathMatcher = (absolutePath: string) => boolean;

export function pathMatcher(
  specifier: string,
  workspaceRoot: string,
  home: string = homedir(),
): PathMatcher {
  const dirOnly = specifier.endsWith('/');
  const spec = dirOnly ? `${specifier}**` : specifier;
  // `//C:/data` is a drive path on Windows; `//srv/data` is `/srv/data` elsewhere.
  if (spec.startsWith('//'))
    return absolute(new Glob(/^\/\/[A-Za-z]:\//.test(spec) ? spec.slice(2) : spec.slice(1)));
  if (spec.startsWith('~/')) return absolute(new Glob(`${toSlash(home)}/${spec.slice(2)}`));
  const rel = spec.replace(/^\.?\//, '');
  const anchored = spec.startsWith('/') || spec.startsWith('./') || rel.includes('/');
  const glob = new Glob(anchored ? rel : `{${rel},**/${rel}}`);
  return (path) => {
    const r = relative(workspaceRoot, path);
    if (r.startsWith('..') || isAbsolute(r)) return false;
    const p = toSlash(r);
    // A directory matches a pattern for what's inside it (`src` and `src/**`).
    return glob.match(p) || glob.match(`${p}/`);
  };
}

function absolute(glob: Glob): PathMatcher {
  return (path) => glob.match(toSlash(path)) || glob.match(`${toSlash(path)}/`);
}

function toSlash(p: string): string {
  return p.split(sep).join('/');
}

/**
 * A tool's path input as the paths rules are matched against: as written
 * (`~/` expanded, relative to the session's root) and canonical (symlinks
 * resolved, so `/tmp` is also `/private/tmp` on macOS). A rule matches if
 * either does.
 */
export function toolPaths(root: string, path: unknown, home: string = homedir()): string[] {
  if (typeof path !== 'string') return [];
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  const written = resolve(root, expanded);
  const canonical = resolveFile(root, path, home);
  return written === canonical ? [written] : [written, canonical];
}
