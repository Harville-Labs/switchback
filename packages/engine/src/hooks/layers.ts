/**
 * Hooks add up across config layers, like permission rules: the user's,
 * the project's, and an organization's all run. A project's hooks run
 * commands from a checked-out repository, so they wait for the user's trust
 * (`switchback hooks trust`), keyed by their exact definition.
 */
import { isTrusted } from '../trust.ts';
import { HOOK_EVENTS, type HookEvent, type HookMatcher, type HooksConfig } from './schema.ts';

export interface SourcedHook {
  event: HookEvent;
  matcher: HookMatcher;
  source: string;
  project: boolean;
  fromOrg: boolean;
}

/** The trust key of one project hook: its event and exact definition. */
export function hookTrustKey(h: Pick<SourcedHook, 'event' | 'matcher'>): string {
  return `hook:${h.event}:${JSON.stringify(h.matcher)}`;
}

export class HookLayers {
  private hooks: SourcedHook[] = [];

  /** The layer without its hooks, which are collected here instead. */
  take(
    layer: Record<string, unknown>,
    source: string,
    where: { project?: boolean; org?: boolean } = {},
  ): Record<string, unknown> {
    const hooks = layer.hooks as Record<string, unknown> | undefined;
    if (!hooks || typeof hooks !== 'object') return layer;
    for (const event of HOOK_EVENTS) {
      const list = hooks[event];
      if (!Array.isArray(list)) continue;
      for (const matcher of list)
        this.hooks.push({
          event,
          matcher: matcher as HookMatcher,
          source,
          project: !!where.project,
          fromOrg: !!where.org,
        });
    }
    const { hooks: _taken, ...rest } = layer;
    return rest;
  }

  /**
   * The hooks that may run. Project hooks not yet trusted are held back;
   * with `orgOnly` (an organization's `allowUserHooks: false`), only the
   * organization's run.
   */
  result(
    workspaceRoot: string,
    env: Record<string, string | undefined>,
    orgOnly: boolean,
  ): { hooks: HooksConfig; untrusted: SourcedHook[]; dropped: SourcedHook[] } {
    const hooks: HooksConfig = {};
    const untrusted: SourcedHook[] = [];
    const dropped: SourcedHook[] = [];
    for (const h of this.hooks) {
      if (orgOnly && !h.fromOrg) dropped.push(h);
      else if (h.project && !isTrusted(workspaceRoot, hookTrustKey(h), h.matcher, env))
        untrusted.push(h);
      else hooks[h.event] = [...(hooks[h.event] ?? []), h.matcher];
    }
    return { hooks, untrusted, dropped };
  }
}
