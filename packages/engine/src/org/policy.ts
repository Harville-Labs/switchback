/**
 * Organization policy: configuration an org server pushes to signed-in users.
 *
 * - `defaults` is a config layer below the user's own config (e.g. the
 *   company's local model servers), so users can still adjust it.
 * - `enforced` is a layer above everything; users cannot override it.
 * - `restrictions` are applied to the merged result: they remove what isn't
 *   allowed rather than merely changing defaults.
 *
 * See docs/organizations.md for the server contract.
 */
import type { OrgPolicy, PROVIDER_TYPES } from '@harville-labs/switchback-org/policy';
import { type ProviderConfig, tierOf } from '@switchback/providers';
import type { SwitchbackConfig } from '../config.ts';

export { OrgPolicy } from '@harville-labs/switchback-org/policy';

// The policy format lives outside the engine so servers can use it, so it can't
// import ProviderConfig. These fail to compile when the two lists drift apart.
type PolicyProviderType = (typeof PROVIDER_TYPES)[number];
true satisfies ProviderConfig['type'] extends PolicyProviderType ? true : false;
true satisfies PolicyProviderType extends ProviderConfig['type'] ? true : false;

export interface OrgStatus {
  id: string;
  name: string;
  version: string;
  /** Human-readable account of what the policy changed or removed. */
  notes: string[];
  /** Config paths set by `enforced`. */
  enforcedKeys: string[];
  /** The policy disables remote models entirely. */
  remoteDisabled: boolean;
  /** Sessions can't use the `bypassPermissions` mode. */
  bypassDisabled: boolean;
  /** Members can't set their own permissions (`allowUserPermissions: false`). */
  userPermissionsDisabled: boolean;
}

/** Dotted paths of every leaf set by a layer, e.g. `routing.budget.dailyUsd`. */
export function leafPaths(layer: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(layer).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? leafPaths(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

/** The config's roles with only the aliases `keep` accepts; a step left empty is dropped. */
function filterRoles(
  config: SwitchbackConfig,
  keep: (alias: string, role: string) => boolean,
): Pick<SwitchbackConfig, 'routing' | 'review' | 'subagents'> {
  const routing = structuredClone(config.routing);
  routing.start = routing.start.filter((a) => keep(a, 'routing.start'));
  routing.escalate = routing.escalate
    .map((step) => step.filter((a) => keep(a, 'routing.escalate')))
    .filter((step) => step.length);
  const review = {
    ...config.review,
    models: config.review.models
      .map((step) => step.filter((a) => keep(a, 'review.models')))
      .filter((step) => step.length),
  };
  const subagents = { ...config.subagents };
  if (subagents.model && !keep(subagents.model, 'subagents.model')) delete subagents.model;
  return { routing, review, subagents };
}

/** Every model alias a config layer names in a role. */
function roleAliases(layer: Record<string, unknown>): Set<string> {
  const routing = (layer.routing ?? {}) as Record<string, unknown>;
  const review = (layer.review ?? {}) as Record<string, unknown>;
  const subagents = (layer.subagents ?? {}) as Record<string, unknown>;
  const classifier = (routing.classifier ?? {}) as Record<string, unknown>;
  return new Set(
    [routing.start, routing.escalate, review.models, classifier.model, subagents.model]
      .flat(2)
      .filter((a): a is string => typeof a === 'string'),
  );
}

/**
 * Drop role aliases the policy names that no layer defines. A policy is written
 * once for every member, so it may offer a model only some of them have, such
 * as their own `local` (`"start": ["local", "acme-gpu"]`); members without it
 * use the rest of the chain. Aliases only the user names are left for config
 * validation, so the user's own typos are still reported.
 */
export function dropMissingPolicyAliases(
  config: SwitchbackConfig,
  policy: OrgPolicy,
): { config: SwitchbackConfig; notes: string[] } {
  const offered = new Set([...roleAliases(policy.defaults), ...roleAliases(policy.enforced)]);
  const notes: string[] = [];
  const roles = filterRoles(config, (alias, role) => {
    if (config.models[alias] || !offered.has(alias)) return true;
    notes.push(`${role}: "${alias}" skipped; no model has that alias here`);
    return false;
  });
  return { config: { ...config, ...roles }, notes };
}

/** Apply restrictions to an already-merged config. Returns a new config and notes. */
export function applyRestrictions(
  config: SwitchbackConfig,
  policy: OrgPolicy,
): { config: SwitchbackConfig; notes: string[] } {
  const r = policy.restrictions;
  const notes: string[] = [];
  const orgProviderIds = new Set([
    ...Object.keys((policy.defaults.providers as Record<string, unknown>) ?? {}),
    ...Object.keys((policy.enforced.providers as Record<string, unknown>) ?? {}),
  ]);

  const providers: SwitchbackConfig['providers'] = {};
  for (const [id, pc] of Object.entries(config.providers)) {
    let why: string | undefined;
    if (!r.allowRemote && tierOf(pc) === 'remote') why = 'remote providers are disabled';
    else if (r.allowedProviderTypes && !r.allowedProviderTypes.includes(pc.type))
      why = `provider type "${pc.type}" is not allowed`;
    else if (!r.allowUserProviders && !orgProviderIds.has(id))
      why = 'only organization-defined providers are allowed';
    if (why) notes.push(`provider "${id}" removed: ${why}`);
    else providers[id] = pc;
  }

  const models: SwitchbackConfig['models'] = {};
  for (const [alias, m] of Object.entries(config.models)) {
    if (providers[m.provider]) models[alias] = m;
  }

  const orgMcp = new Set([
    ...Object.keys((policy.defaults.mcpServers as Record<string, unknown>) ?? {}),
    ...Object.keys((policy.enforced.mcpServers as Record<string, unknown>) ?? {}),
  ]);
  const mcpServers: SwitchbackConfig['mcpServers'] = {};
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (r.allowUserMcpServers || orgMcp.has(name)) mcpServers[name] = server;
    else
      notes.push(`MCP server "${name}" removed: only organization-defined MCP servers are allowed`);
  }

  // Roles keep only models that survived.
  const { routing, review, subagents } = filterRoles(config, (alias, role) => {
    if (models[alias]) return true;
    notes.push(`${role}: "${alias}" removed with its provider`);
    return false;
  });
  if (!r.allowRemote) {
    if (routing.allowRemote) notes.push('remote models turned off');
    routing.allowRemote = false;
  }
  const cap = (value: number | undefined, max: number | undefined, label: string) => {
    if (max === undefined) return value;
    if (value === undefined || value > max) {
      notes.push(`${label} capped at $${max}`);
      return max;
    }
    return value;
  };
  const daily = cap(routing.budget.dailyUsd, r.maxDailyUsd, 'daily remote budget');
  const monthly = cap(routing.budget.monthlyUsd, r.maxMonthlyUsd, 'monthly remote budget');
  routing.budget = {
    ...routing.budget,
    ...(daily !== undefined ? { dailyUsd: daily } : {}),
    ...(monthly !== undefined ? { monthlyUsd: monthly } : {}),
  };
  let { permissions } = config;
  if (!r.allowBypassPermissions && permissions.defaultMode === 'bypassPermissions') {
    notes.push('permissions.defaultMode bypassPermissions turned off');
    permissions = { ...permissions, defaultMode: 'default' };
  }
  return {
    config: { ...config, providers, models, routing, review, subagents, mcpServers, permissions },
    notes,
  };
}
