/**
 * What a project defines that runs commands on this machine (MCP servers and
 * hooks in its `.switchback/config.json`) comes from a checked-out repository,
 * so it only runs after the user trusts it for that workspace. Trust is keyed
 * by the exact definition: editing one means approving it again. Keys are
 * namespaced: `mcp:<name>`, `hook:<event>:<definition>`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { switchbackPaths } from './paths.ts';

type Env = Record<string, string | undefined>;
type TrustFile = Record<string, Record<string, string>>;

function trustFile(env: Env): string {
  return join(switchbackPaths(env).dataDir, 'trust.json');
}

export function definitionHash(definition: unknown): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 16);
}

function read(env: Env): TrustFile {
  const file = trustFile(env);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as TrustFile;
  } catch {
    return {};
  }
}

export function isTrusted(
  workspaceRoot: string,
  key: string,
  definition: unknown,
  env: Env,
): boolean {
  return read(env)[workspaceRoot]?.[key] === definitionHash(definition);
}

/** Trust these definitions, by key, as they are now. */
export function trust(
  workspaceRoot: string,
  entries: Record<string, unknown>,
  env: Env = process.env,
): void {
  const all = read(env);
  const mine = { ...(all[workspaceRoot] ?? {}) };
  for (const [key, def] of Object.entries(entries)) mine[key] = definitionHash(def);
  all[workspaceRoot] = mine;
  const file = trustFile(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}
