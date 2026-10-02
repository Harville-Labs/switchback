import { z } from 'zod';

export const EscalationConfig = z.object({
  /**
   * `auto`: escalate without asking. `ask`: emit `escalation.requested` and wait
   * for the user before escalating to a remote model (local steps never ask).
   * `off`: never escalate on quality signals (context overflow and outages
   * still move).
   */
  policy: z.enum(['auto', 'ask', 'off']).default('auto'),
  /** Consecutive failed tool calls before the model is considered stuck. */
  maxConsecutiveToolErrors: z.number().int().positive().default(3),
  /** Malformed tool calls (unparseable args, unknown tool) in the current turn. */
  maxMalformedToolCalls: z.number().int().positive().default(2),
  /** Identical tool call repeated this many times counts as a loop. */
  loopThreshold: z.number().int().positive().default(3),
  /** A model fits a prompt when the estimate is at most this fraction of its window. */
  contextHeadroom: z.number().min(0.1).max(1).default(0.85),
  /** After an escalation, stay on the step it reached for this many model calls. */
  stickyTurns: z.number().int().nonnegative().default(2),
});

export const BudgetConfig = z.object({
  dailyUsd: z.number().positive().optional(),
  monthlyUsd: z.number().positive().optional(),
  /** What to do with a remote-bound turn once a budget is exhausted. */
  onExceeded: z.enum(['local', 'block']).default('local'),
});

/**
 * One model alias or an ordered list of alternatives: the router uses the
 * first that is reachable and whose context window fits, so a chain can mix
 * servers and providers: `["laptop", "gpu-box"]`, `["opus", "opus-aws"]`.
 */
export const ModelChain = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((v) => (typeof v === 'string' ? [v] : v));

/**
 * Roles, filled by any model (ADR 0015). Whether a model is local or remote is
 * a property of its provider: it decides cost, budgets, `ask` prompts,
 * privacy, and `allowRemote`, never which role a model can fill.
 */
export const RoutingConfig = z.object({
  /** Where turns begin: a chain of alternatives. */
  start: ModelChain.default([]),
  /**
   * The escalation ladder. Each escalation moves one step up; each step is an
   * alias or a chain of alternatives (`["large", ["opus", "opus-aws"]]`).
   */
  escalate: z.array(ModelChain).default([]),
  /** False: never call a remote model, even one configured in a role. */
  allowRemote: z.boolean().default(true),
  escalation: EscalationConfig.prefault({}),
  /**
   * Optional pre-routing classifier: a small model rates each new prompt, and
   * prompts rated `escalateOn` or harder start one step up the ladder
   * (subject to `escalation.policy`). Off unless configured.
   */
  classifier: z
    .object({
      /** Model alias; any model, though a small local one keeps it free and fast. */
      model: z.string(),
      escalateOn: z.enum(['medium', 'hard']).default('hard'),
      /** Skip the rating if the model hasn't answered by then. */
      timeoutMs: z.number().int().positive().default(1_500),
    })
    .optional(),
  budget: BudgetConfig.prefault({}),
  /**
   * When every model on the chosen step is down: `nearest` uses the nearest
   * other step that's up (higher first, then lower); `none` stops instead.
   */
  fallback: z.enum(['nearest', 'none']).default('nearest'),
});

export type RoutingConfig = z.infer<typeof RoutingConfig>;
export type EscalationConfig = z.infer<typeof EscalationConfig>;
export type BudgetConfig = z.infer<typeof BudgetConfig>;
