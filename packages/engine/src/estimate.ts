/**
 * What approving an escalation will roughly cost, shown in the prompt so the
 * user isn't approving blind. It needs to be the right order of magnitude, not
 * exact: the target is within 2x of the real bill.
 */
import { costUsd, type Price } from '@switchback/providers';

/** Used until a session has history to learn from; typical of one agentic step. */
export const DEFAULT_OUTPUT_TOKENS = 800;

export function estimateEscalationCost(o: {
  price: Price | undefined;
  inputTokens: number;
  /** Mean output per call in this session, if known. */
  outputTokens?: number;
  /** The escalated call plus the sticky turns that follow it. */
  calls: number;
}): number | undefined {
  if (!o.price) return undefined;
  const out = Math.round(o.outputTokens ?? DEFAULT_OUTPUT_TOKENS);
  // The first call pays full price for the prompt. Later calls in the sticky
  // run reuse it through the provider's prompt cache and pay full price only
  // for what the previous step added (its output plus a tool result about as
  // large).
  const first = costUsd({ inputTokens: o.inputTokens, outputTokens: out }, o.price);
  let total = first;
  let prefix = o.inputTokens;
  for (let i = 1; i < o.calls; i++) {
    total += costUsd({ inputTokens: 2 * out, cacheReadTokens: prefix, outputTokens: out }, o.price);
    prefix += 2 * out;
  }
  return total;
}
