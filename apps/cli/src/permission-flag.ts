import { parseLevel } from '@switchback/client';
import type { PermissionLevel } from '@switchback/protocol';

export interface PermissionFlag {
  permissionLevel?: PermissionLevel;
  /** `plan` was a permission mode before it became an agent (ADR 0029). */
  agent?: string;
  warning?: string;
}

/**
 * `--permission-mode`, which takes the levels and the mode names from before
 * ADR 0029. Throws a message naming the accepted values on anything else.
 */
export function permissionFlag(value: string | undefined): PermissionFlag {
  if (value === undefined) return {};
  const key = value.toLowerCase();
  if (key === 'plan') return { agent: 'plan' };
  if (key === 'acceptedits')
    return {
      permissionLevel: 'ask',
      warning:
        '--permission-mode acceptEdits is now the ask level; set permissions.edit to "allow" to keep edits from asking (docs/permissions.md)',
    };
  const permissionLevel = parseLevel(value);
  if (!permissionLevel) throw new Error('--permission-mode must be ask, auto, or bypass');
  return { permissionLevel };
}
