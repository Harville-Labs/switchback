/**
 * A session's roles (ADR 0015): the config's, with whatever the session
 * changed through `session.setRoles`.
 */
import {
  ErrorCode,
  RpcError,
  type SessionRoles,
  type SessionSetRolesParams,
} from '@switchback/protocol';
import { configRoles, type SwitchbackConfig } from './config.ts';
import type { LiveSession } from './live-session.ts';
import type { OrgStatus } from './org/policy.ts';

export type RoleOverrides = NonNullable<LiveSession['roles']>;

export function effectiveRoles(config: SwitchbackConfig, own: RoleOverrides = {}): SessionRoles {
  const base = configRoles(config);
  const sub = own.subagents === null ? undefined : (own.subagents ?? base.subagents);
  return {
    current: own.current ?? base.current,
    escalate: own.escalate ?? base.escalate,
    review: {
      mode: own.review?.mode ?? base.review.mode,
      models: own.review?.models ?? base.review.models,
    },
    ...(sub ? { subagents: sub } : {}),
    overridden: (['current', 'escalate', 'review', 'subagents'] as const).filter(
      (k) => own[k] !== undefined,
    ),
  };
}

/**
 * The session's overrides after a `session.setRoles` call. Throws when it
 * names a model that isn't configured or a role an organization enforces.
 */
export function changeRoles(
  current: RoleOverrides | undefined,
  params: SessionSetRolesParams,
  config: SwitchbackConfig,
  org: OrgStatus | undefined,
): RoleOverrides {
  const named = [
    ...(params.current ?? []),
    ...(params.escalate?.flat() ?? []),
    ...(params.review?.models?.flat() ?? []),
    ...(params.subagents ? [params.subagents] : []),
  ];
  const unknown = named.find((a) => !config.models[a]);
  if (unknown)
    throw new RpcError(
      ErrorCode.InvalidParams,
      `"${unknown}" is not a configured model (${Object.keys(config.models).join(', ')})`,
    );
  const locked = [
    ['current', 'routing.current'],
    ['escalate', 'routing.escalate'],
    ['review', 'review.'],
    ['subagents', 'subagents.model'],
  ].find(
    ([param, key]) =>
      params[param as keyof SessionSetRolesParams] !== undefined &&
      org?.enforcedKeys.some((k) => k.startsWith(key as string)),
  );
  if (locked && org)
    throw new RpcError(
      ErrorCode.InvalidParams,
      `${org.name}'s policy sets ${locked[1]?.replace(/\.$/, '')}; it can't be changed here`,
    );
  const roles = params.reset ? {} : { ...current };
  if (params.current) roles.current = params.current;
  if (params.escalate) roles.escalate = params.escalate;
  if (params.review) roles.review = { ...roles.review, ...params.review };
  if (params.subagents !== undefined) roles.subagents = params.subagents;
  return roles;
}

/** The config layer that makes these roles the default for new sessions. */
export function rolesLayer(roles: SessionRoles): Record<string, unknown> {
  return {
    routing: { current: roles.current, escalate: roles.escalate },
    review: roles.review,
    ...(roles.subagents ? { subagents: { model: roles.subagents } } : {}),
  };
}
