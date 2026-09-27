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
import { type ProviderConfig, tierOf } from '@harness/providers';
import { z } from 'zod';
import type { HarnessConfig } from '../config.ts';

const PROVIDER_TYPES = [
  'openai-compatible',
  'openai',
  'deepseek',
  'anthropic',
  'bedrock',
  'vertex',
  'mock',
] as const satisfies readonly ProviderConfig['type'][];

export const OrgPolicy = z.object({
  /** Server-assigned revision, shown to users and admins. */
  version: z.union([z.string(), z.number()]).transform(String),
  org: z.object({ id: z.string(), name: z.string() }),
  defaults: z.record(z.string(), z.unknown()).default({}),
  enforced: z.record(z.string(), z.unknown()).default({}),
  restrictions: z
    .object({
      /** false: no remote providers at all; everything runs locally. */
      allowRemote: z.boolean().default(true),
      /** Only these provider types may be used (org- or user-defined). */
      allowedProviderTypes: z.array(z.enum(PROVIDER_TYPES)).optional(),
      /** false: only providers defined by the org policy may be used. */
      allowUserProviders: z.boolean().default(true),
      /** Per-user remote spend caps; users may set lower budgets, never higher. */
      maxDailyUsd: z.number().positive().optional(),
      maxMonthlyUsd: z.number().positive().optional(),
    })
    .prefault({}),
  /** How often clients re-check for updates. */
  refreshSeconds: z.number().int().min(30).max(86_400).default(300),
});
export type OrgPolicy = z.infer<typeof OrgPolicy>;

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
}

/** Dotted paths of every leaf set by a layer, e.g. `routing.budget.dailyUsd`. */
export function leafPaths(layer: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(layer).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? leafPaths(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

/** Apply restrictions to an already-merged config. Returns a new config and notes. */
export function applyRestrictions(
  config: HarnessConfig,
  policy: OrgPolicy,
): { config: HarnessConfig; notes: string[] } {
  const r = policy.restrictions;
  const notes: string[] = [];
  const orgProviderIds = new Set([
    ...Object.keys((policy.defaults.providers as Record<string, unknown>) ?? {}),
    ...Object.keys((policy.enforced.providers as Record<string, unknown>) ?? {}),
  ]);

  const providers: HarnessConfig['providers'] = {};
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

  const models: HarnessConfig['models'] = {};
  for (const [alias, m] of Object.entries(config.models)) {
    if (providers[m.provider]) models[alias] = m;
  }

  const routing = structuredClone(config.routing);
  if (!r.allowRemote) {
    if (routing.mode !== 'local-only') notes.push('routing forced to local-only');
    routing.mode = 'local-only';
    routing.escalation.policy = 'off';
    routing.fallback.onLocalUnavailable = 'fail';
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
  return { config: { ...config, providers, models, routing }, notes };
}
