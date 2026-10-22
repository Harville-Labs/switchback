/** Permission levels: which ones a session may use. */
import { ErrorCode, PermissionLevel, RpcError } from '@switchback/protocol';
import type { OrgStatus } from '../org/policy.ts';

export function allowedLevels(org: OrgStatus | undefined): PermissionLevel[] {
  return PermissionLevel.options.filter((l) => l !== 'bypass' || !org?.bypassDisabled);
}

export function assertLevelAllowed(level: PermissionLevel, org: OrgStatus | undefined): void {
  if (!allowedLevels(org).includes(level))
    throw new RpcError(
      ErrorCode.InvalidParams,
      `${org?.name ?? 'Your organization'}'s policy doesn't allow the ${level} permission level`,
    );
}
