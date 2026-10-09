/**
 * Where a file tool's path goes, for the permission gate (ADR 0018): inside
 * the workspace, somewhere else on this machine, into Switchback's own
 * configuration, or somewhere no tool call may go.
 */
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { ToolCall } from './policy.ts';

export type Reach =
  | { kind: 'inside' }
  | { kind: 'outside'; path: string }
  /** `~/.switchback`, apart from its data and credentials: edits always ask. */
  | { kind: 'switchback'; path: string }
  | { kind: 'off-limits'; path: string; why: string };

export interface Places {
  /** `~/.switchback` (or `SWITCHBACK_HOME`). */
  configDir: string;
  /** Sessions, the usage ledger, checkpoints. */
  dataDir: string;
  /** Credential files and folders (`bash.sandbox.denyRead`), `~/` allowed. */
  denyRead: string[];
  home?: string;
}

/** Paths file tools take: `path` (read, edit, write, glob, grep), `file_path` (external runtimes). */
export function pathOf(call: ToolCall): string | undefined {
  if (call.category !== 'read' && call.category !== 'edit') return undefined;
  const i = (call.input ?? {}) as { path?: unknown; file_path?: unknown };
  const path = i.path ?? i.file_path;
  return typeof path === 'string' ? path : undefined;
}

const under = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel));
};

/**
 * `file` is absolute and canonical (`resolveFile`); `inside` says whether
 * it's in the workspace. Off-limits places win even inside the workspace.
 */
export function reachOf(file: string, inside: boolean, places: Places): Reach {
  const home = places.home ?? homedir();
  const expand = (p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p);
  if (under(file, places.dataDir))
    return { kind: 'off-limits', path: file, why: "Switchback's session data and usage ledger" };
  if (under(file, join(places.configDir, 'auth.json')))
    return { kind: 'off-limits', path: file, why: "Switchback's sign-in credentials" };
  const credential = places.denyRead.map(expand).find((p) => under(file, p));
  if (credential)
    return {
      kind: 'off-limits',
      path: file,
      why: `credentials (${credential} is in bash.sandbox.denyRead)`,
    };
  if (inside) return { kind: 'inside' };
  if (under(file, places.configDir)) return { kind: 'switchback', path: file };
  return { kind: 'outside', path: file };
}

/**
 * The rule "always allow" grants for a path outside the workspace: its
 * folder (a search's own folder), written from `~/` when under the home
 * directory and from `//` otherwise, as rule specifiers are.
 */
export function folderRule(
  category: 'read' | 'edit',
  file: string,
  isFolder: boolean,
  home: string = homedir(),
): string {
  const dir = isFolder ? file : join(file, '..');
  const slashed = dir.split(sep).join('/');
  const homeSlashed = home.split(sep).join('/');
  const spec = under(dir, home)
    ? `~/${slashed.slice(homeSlashed.length + 1)}`
    : `/${slashed.startsWith('/') ? slashed : `/${slashed}`}`;
  return `${category}(${spec.replace(/\/?$/, '/')})`;
}
