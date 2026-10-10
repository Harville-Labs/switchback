/**
 * Signing in hands an organization's permissions to the member: they replace
 * the `permissions` section of the user config, so the member starts from
 * what the organization chose. With `allowUserPermissions`, the member may
 * edit them afterwards; without it, only the policy's own permissions apply
 * whatever the file says (config.ts).
 */

import type { OrgPolicy } from '@harville-labs/switchback-org/policy';
import { writeConfigLayer } from '../setup.ts';

const RULE_LISTS = ['allow', 'ask', 'deny'] as const;

/** The policy's `permissions`, defaults under enforced, rule lists added up. */
export function orgPermissions(policy: OrgPolicy): Record<string, unknown> | undefined {
  const section = (layer: Record<string, unknown>) =>
    (layer.permissions ?? {}) as Record<string, unknown>;
  const defaults = section(policy.defaults);
  const enforced = section(policy.enforced);
  const merged: Record<string, unknown> = { ...defaults, ...enforced };
  for (const list of RULE_LISTS) {
    const rules = [defaults[list], enforced[list]].flatMap((l) => (Array.isArray(l) ? l : []));
    if (rules.length) merged[list] = [...new Set(rules)];
    else delete merged[list];
  }
  return Object.keys(merged).length ? merged : undefined;
}

/**
 * Write the organization's permissions over the user config's. Returns the
 * write's result, or undefined when the policy sets no permissions (the
 * member's own are left alone).
 */
export function adoptOrgPermissions(file: string, policy: OrgPolicy) {
  const permissions = orgPermissions(policy);
  if (!permissions) return undefined;
  return writeConfigLayer(file, { permissions }, { references: false, replace: ['permissions'] });
}
