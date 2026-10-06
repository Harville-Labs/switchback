/** Permission modes: which ones a session may use, and what the model is told about them. */
import { ErrorCode, PermissionMode, RpcError } from '@switchback/protocol';
import type { OrgStatus } from '../org/policy.ts';

export function allowedModes(org: OrgStatus | undefined): PermissionMode[] {
  return PermissionMode.options.filter((m) => m !== 'bypassPermissions' || !org?.bypassDisabled);
}

export function assertModeAllowed(mode: PermissionMode, org: OrgStatus | undefined): void {
  if (!allowedModes(org).includes(mode))
    throw new RpcError(
      ErrorCode.InvalidParams,
      `${org?.name ?? 'Your organization'}'s policy doesn't allow the ${mode} mode`,
    );
}

/**
 * What to tell the model when the mode it knows about changed, or undefined
 * when nothing it does depends on the change. Sent with the next prompt as a
 * reminder part, never in the system prompt (invariant 7).
 */
export function modeReminder(
  told: PermissionMode | undefined,
  now: PermissionMode,
): string | undefined {
  const was = told ?? 'default';
  if (was === now) return undefined;
  if (now === 'plan')
    return 'Plan mode is on. Read and explore as much as you need, but change nothing: no edits, and no commands with side effects. When you have a complete plan, present it with exit_plan_mode; the user approves it before you make changes.';
  if (was === 'plan') return 'Plan mode is off. You may make changes now.';
  return undefined;
}
