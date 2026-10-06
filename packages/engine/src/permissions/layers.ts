/**
 * Permission rules add up across config layers, unlike other arrays (which
 * the later layer replaces): a project can't drop the user's deny rules, and
 * nobody can drop an organization's. Each rule keeps the layer it came from,
 * for `/permissions` and `switchback doctor`.
 */
import type { SourcedRule } from './policy.ts';
import type { RuleBehavior } from './rules.ts';

const BEHAVIORS: RuleBehavior[] = ['allow', 'ask', 'deny'];

export class RuleLayers {
  private rules: (SourcedRule & { fromOrg: boolean })[] = [];

  /** The layer without its rule lists, which are collected here instead. */
  take(layer: Record<string, unknown>, source: string, fromOrg = false): Record<string, unknown> {
    const permissions = layer.permissions as Record<string, unknown> | undefined;
    if (!permissions || typeof permissions !== 'object') return layer;
    const rest = { ...permissions };
    for (const behavior of BEHAVIORS) {
      const list = rest[behavior];
      delete rest[behavior];
      if (!Array.isArray(list)) continue;
      for (const rule of list)
        if (typeof rule === 'string') this.rules.push({ rule, behavior, source, fromOrg });
    }
    return { ...layer, permissions: rest };
  }

  /**
   * Every rule once, first source wins. With `orgOnly` (an organization's
   * `allowUserPermissionRules: false`), allow and ask rules from other layers
   * are left out; deny rules only ever tighten, so they stay.
   */
  result(orgOnly: boolean): {
    lists: Record<RuleBehavior, string[]>;
    sourced: SourcedRule[];
    ignored: SourcedRule[];
  } {
    const seen = new Set<string>();
    const sourced: SourcedRule[] = [];
    const ignored: SourcedRule[] = [];
    for (const { fromOrg, ...r } of this.rules) {
      const key = `${r.behavior}\u0000${r.rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (orgOnly && !fromOrg && r.behavior !== 'deny') ignored.push(r);
      else sourced.push(r);
    }
    const lists = { allow: [], ask: [], deny: [] } as Record<RuleBehavior, string[]>;
    for (const r of sourced) lists[r.behavior].push(r.rule);
    return { lists, sourced, ignored };
  }
}
