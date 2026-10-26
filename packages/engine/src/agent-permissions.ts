/**
 * OpenCode's list form of an agent's permissions (`{ action, resource, effect }`
 * entries) as the table an agent's `permissions` take. An agent can only
 * tighten the config's permissions, so an `allow` entry changes nothing.
 */

import type { AgentPermissions } from './config-schema.ts';
import { permissionTable, translatePermissions } from './dialects/opencode-format.ts';

/**
 * The table, and whether the list turned delegation off (`subagent` denied
 * for everything), which Switchback says with `agents: []`.
 */
export function permissionsFromList(
  list: { action: string; resource?: string | undefined; effect: 'allow' | 'ask' | 'deny' }[],
): { permissions: AgentPermissions; noDelegation: boolean } {
  const table = permissionTable(list) ?? {};
  // Entries it can't express (a pattern for a tool with no rule form) are left out.
  const translated = translatePermissions({ permission: table }, []);
  const out: AgentPermissions = {};
  for (const key of ['read', 'edit', 'bash', 'web', 'mcp'] as const) {
    const level = translated?.levels[key];
    if (level === 'ask' || level === 'deny') out[key] = level;
  }
  // websearch has no level of its own here; deny or ask on it applies to the web category.
  const search = translated?.levels.websearch;
  if ((search === 'ask' || search === 'deny') && !out.web) out.web = search;
  if (translated?.ask.length) out.ask = translated.ask;
  if (translated?.deny.length) out.deny = translated.deny;
  const delegation = { ...(table.subagent as object), ...(table.task as object) } as Record<
    string,
    unknown
  >;
  return { permissions: out, noDelegation: delegation['*'] === 'deny' };
}
