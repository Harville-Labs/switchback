import { z } from 'zod';

export const EscalationConfig = z.object({
  /**
   * `auto`: escalate without asking. `ask`: emit `escalation.requested` and wait
   * for the user. `off`: never escalate on quality signals (context overflow and
   * outages still fall back).
   */
  policy: z.enum(['auto', 'ask', 'off']).default('auto'),
  /** Consecutive failed tool calls before the local model is considered stuck. */
  maxConsecutiveToolErrors: z.number().int().positive().default(3),
  /** Malformed tool calls (unparseable args, unknown tool) in the current turn. */
  maxMalformedToolCalls: z.number().int().positive().default(2),
  /** Identical tool call repeated this many times counts as a loop. */
  loopThreshold: z.number().int().positive().default(3),
  /** Escalate when estimated input exceeds this fraction of the local context window. */
  contextHeadroom: z.number().min(0.1).max(1).default(0.85),
  /** After an escalation, keep routing remote for this many turns before retrying local. */
  stickyTurns: z.number().int().nonnegative().default(2),
});

export const BudgetConfig = z.object({
  dailyUsd: z.number().positive().optional(),
  monthlyUsd: z.number().positive().optional(),
  /** What to do with a remote-bound turn once a budget is exhausted. */
  onExceeded: z.enum(['local', 'block']).default('local'),
});

/**
 * One model alias or an ordered list. The router uses the first model in the
 * list that is reachable and whose context window fits the prompt, so a list
 * can mix servers: `["laptop", "gpu-box"]`.
 */
const ModelChain = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((v) => (typeof v === 'string' ? [v] : v));

export const RoutingConfig = z.object({
  mode: z.enum(['auto', 'local-only', 'remote-only']).default('auto'),
  /** Model aliases for local turns, in order of preference. */
  local: ModelChain.default(['local']),
  /** Model aliases for escalated and remote turns, in order of preference. */
  remote: ModelChain.default(['remote']),
  escalation: EscalationConfig.prefault({}),
  budget: BudgetConfig.prefault({}),
  fallback: z
    .object({
      onLocalUnavailable: z.enum(['remote', 'fail']).default('remote'),
      onRemoteUnavailable: z.enum(['local', 'fail']).default('local'),
    })
    .prefault({}),
});

export type RoutingConfig = z.infer<typeof RoutingConfig>;
export type EscalationConfig = z.infer<typeof EscalationConfig>;
export type BudgetConfig = z.infer<typeof BudgetConfig>;
