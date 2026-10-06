/**
 * Hooks: per event, matchers with the commands to run. Read only from
 * Switchback's own config files (ADR 0016).
 */
import { z } from 'zod';

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'Notification',
] as const;
export const HookEvent = z.enum(HOOK_EVENTS);
export type HookEvent = z.infer<typeof HookEvent>;

export const HookCommand = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
  /** Seconds before the command is killed (default 60). */
  timeout: z.number().positive().max(3600).optional(),
});
export type HookCommand = z.infer<typeof HookCommand>;

export const HookMatcher = z.object({
  /**
   * Tool events: a regular expression for the tool name, case-insensitive
   * (`bash|edit`, `mcp__github__.*`). SessionStart: `startup`
   * or `resume`. Empty or `*` matches everything.
   */
  matcher: z.string().optional(),
  hooks: z.array(HookCommand).min(1),
});
export type HookMatcher = z.infer<typeof HookMatcher>;

export const HooksConfig = z.partialRecord(HookEvent, z.array(HookMatcher));
export type HooksConfig = z.infer<typeof HooksConfig>;
