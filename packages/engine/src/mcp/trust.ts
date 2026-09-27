/**
 * MCP servers defined by a project (its `.harness/config.json` or Claude
 * Code's `.mcp.json`) run commands from a checked-out repository, so they only
 * start after the user trusts them for that workspace. Trust is keyed by the
 * exact definition: editing a server means approving it again.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { harnessPaths } from '../paths.ts';

type Env = Record<string, string | undefined>;
type TrustFile = Record<string, Record<string, string>>;

function trustFile(env: Env): string {
  return join(harnessPaths(env).dataDir, 'mcp-trust.json');
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
  name: string,
  definition: unknown,
  env: Env,
): boolean {
  return read(env)[workspaceRoot]?.[name] === definitionHash(definition);
}

export function trustServers(
  workspaceRoot: string,
  servers: Record<string, unknown>,
  env: Env = process.env,
): void {
  const all = read(env);
  const mine = { ...(all[workspaceRoot] ?? {}) };
  for (const [name, def] of Object.entries(servers)) mine[name] = definitionHash(def);
  all[workspaceRoot] = mine;
  const file = trustFile(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}
