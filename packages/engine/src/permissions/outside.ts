/**
 * Where a file tool's path goes, for the permission gate (ADR 0018): inside
 * the workspace, somewhere else on this machine, into Switchback's own
 * configuration, or somewhere no tool call may go.
 */
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { resolveFile } from '../tools/tool.ts';
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
 * it's in the session's root. Places are compared canonically too, so a
 * symlinked home or `SWITCHBACK_HOME` can't hide them. Credentials are off
 * limits even inside the root; Switchback's data directory isn't, because a
 * subagent's worktree lives there.
 */
export function reachOf(file: string, inside: boolean, places: Places): Reach {
  const home = places.home ?? homedir();
  const real = (p: string) => resolveFile('/', p, home);
  const configDir = real(places.configDir);
  if (!inside && under(file, real(places.dataDir)))
    return { kind: 'off-limits', path: file, why: "Switchback's session data and usage ledger" };
  if (under(file, join(configDir, 'auth.json')))
    return { kind: 'off-limits', path: file, why: "Switchback's sign-in credentials" };
  const credential = places.denyRead.map(real).find((p) => under(file, p));
  if (credential)
    return {
      kind: 'off-limits',
      path: file,
      why: `credentials (${credential} is in bash.sandbox.denyRead)`,
    };
  if (inside) return { kind: 'inside' };
  if (under(file, configDir)) return { kind: 'switchback', path: file };
  return { kind: 'outside', path: file };
}

/**
 * The rule "always allow" grants for an edit outside the workspace: the
 * file's folder, written from `~/` when under the home directory and from
 * `//` otherwise, as rule specifiers are (`//C:/...` on Windows).
 */
export function folderRule(file: string, home: string = homedir()): string {
  const slashed = join(file, '..').split(sep).join('/');
  const homeSlashed = home.split(sep).join('/');
  const spec =
    slashed === homeSlashed || slashed.startsWith(`${homeSlashed}/`)
      ? `~/${slashed.slice(homeSlashed.length + 1)}`
      : `/${slashed.startsWith('/') ? slashed : `/${slashed}`}`;
  return `edit(${spec.replace(/\/?$/, '/')})`;
}
