/**
 * MCP servers a project defines, in `.switchback/` or in `.mcp.json`, the file
 * most MCP clients read for a repository's servers (ADR 0030). They start
 * without asking, as other MCP clients start them, unless `requireMcpTrust` is on.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { parseJsonc } from '../config.ts';
import { isTrusted } from '../trust.ts';
import { McpServerConfig, McpServerName } from './config.ts';

export const MCP_JSON = '.mcp.json';

export function mcpJsonFile(workspaceRoot: string): string {
  return join(workspaceRoot, MCP_JSON);
}

export interface UntrustedMcp {
  name: string;
  source: string;
  definition: unknown;
}

/** Where each MCP server's effective definition came from, layer by layer. */
export class McpSources {
  private readonly from = new Map<string, { project: boolean; file: string }>();

  note(layer: unknown, project: boolean, file: string): void {
    const servers = (layer as { mcpServers?: unknown } | undefined)?.mcpServers;
    if (servers && typeof servers === 'object')
      for (const name of Object.keys(servers)) this.from.set(name, { project, file });
  }

  /**
   * The merged config's servers, without the project's untrusted ones when it
   * sets `requireMcpTrust`. Trust is per definition, so a project redefining a
   * user's server needs it too.
   */
  holdUntrusted(
    merged: Record<string, unknown>,
    workspaceRoot: string,
    env: Record<string, string | undefined>,
  ): { servers: Record<string, unknown>; untrusted: UntrustedMcp[] } {
    const servers = { ...((merged.mcpServers as Record<string, unknown> | undefined) ?? {}) };
    const untrusted: UntrustedMcp[] = [];
    if (merged.requireMcpTrust !== true) return { servers, untrusted };
    for (const [name, definition] of Object.entries(servers)) {
      const source = this.from.get(name);
      if (source?.project && !isTrusted(workspaceRoot, `mcp:${name}`, definition, env)) {
        delete servers[name];
        untrusted.push({ name, source: source.file, definition });
      }
    }
    return { servers, untrusted };
  }
}

/**
 * `.mcp.json`'s servers as a config layer, or undefined when there's no file.
 * Only `mcpServers` is read. The file is other tools' as much as Switchback's,
 * so a server Switchback can't run is skipped with a warning, not an error.
 */
export function readMcpJson(
  file: string,
  env: Record<string, string | undefined>,
): { layer: { mcpServers: Record<string, unknown> }; warnings: string[] } | undefined {
  if (!existsSync(file)) return undefined;
  const warnings: string[] = [];
  const skip = (why: string) => {
    warnings.push(`${MCP_JSON}: ${why}`);
    return { layer: { mcpServers: {} }, warnings };
  };
  let parsed: unknown;
  try {
    parsed = parseJsonc(readFileSync(file, 'utf8'));
  } catch (err) {
    return skip(`ignored, invalid JSON at ${(err as Error).message}`);
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (servers === undefined) return skip('ignored, it has no "mcpServers"');
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers))
    return skip('ignored, "mcpServers" must be an object');
  const mcpServers: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(servers)) {
    const translated = withEnvReferences(def, env);
    const problem =
      issue(McpServerName.safeParse(name)) ?? issue(McpServerConfig.safeParse(translated));
    if (problem) warnings.push(`${MCP_JSON}: server "${name}" skipped: ${problem}`);
    else mcpServers[name] = translated;
  }
  return { layer: { mcpServers }, warnings };
}

function issue(result: { error?: z.ZodError }): string | undefined {
  const first = result.error?.issues[0];
  if (!first) return undefined;
  return first.path.length ? `${first.path.join('.')}: ${first.message}` : first.message;
}

/**
 * `.mcp.json` writes environment variables as `${NAME}` or `${NAME:-default}`;
 * Switchback's form is `{env:NAME}`. A default is used only when the variable
 * is unset now, since `{env:NAME}` has no default of its own.
 */
function withEnvReferences(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === 'string')
    return value.replace(
      /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g,
      (_, name: string, fallback?: string) =>
        fallback !== undefined && env[name] === undefined ? fallback : `{env:${name}}`,
    );
  if (Array.isArray(value)) return value.map((v) => withEnvReferences(v, env));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withEnvReferences(v, env)]),
    );
  return value;
}
