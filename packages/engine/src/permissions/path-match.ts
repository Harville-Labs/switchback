/**
 * Path specifiers for `read(...)` and `edit(...)` rules, gitignore-style:
 *
 * - `src/**`, `./docs/*.md`: relative to the workspace root
 * - `.env`, `*.pem` (no slash): that name at any depth
 * - `/build/**`: anchored at the workspace root
 * - `~/.ssh/**`, `//etc/hosts`: absolute paths (home directory, filesystem root)
 * - a trailing `/` means everything under that directory
 */
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Glob } from 'bun';

export type PathMatcher = (absolutePath: string) => boolean;

export function pathMatcher(
  specifier: string,
  workspaceRoot: string,
  home: string = homedir(),
): PathMatcher {
  const dirOnly = specifier.endsWith('/');
  const spec = dirOnly ? `${specifier}**` : specifier;
  if (spec.startsWith('//')) return absolute(new Glob(spec.slice(1)));
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

/** A tool's path input, resolved against the session's root. */
export function resolveToolPath(root: string, path: unknown): string | undefined {
  return typeof path === 'string' ? resolve(root, path) : undefined;
}
