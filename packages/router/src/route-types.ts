/**
 * The router's contract: what it's told about a call (`RouteInput`), what it
 * knows about each model (`ModelInfo`), and what it decides (`RouteDecision`).
 */
import type { ModelRef, RoutePreference, Tier } from '@switchback/protocol';
import type { SignalSnapshot } from './signals.ts';

export interface ModelInfo {
  alias: string;
  ref: ModelRef;
  tier: Tier;
  contextWindow: number;
  available: boolean;
  /** Can read images (`models.<alias>.vision`, or known from the catalog). */
  vision?: boolean;
}

export interface RouteInput {
  /** Per-turn override from the user (`/remote`, `--route local`, VS Code toggle): a tier filter. */
  preference: RoutePreference;
  /** From the active agent's definition. */
  agent: { name: string; route: RoutePreference; model?: string };
  estimatedInputTokens: number;
  /** The conversation holds images: among a step's alternatives, prefer one that can see them. */
  images?: boolean;
  signals: SignalSnapshot;
  spend: { todayUsd: number; monthUsd: number };
  /** Set when the user already approved an escalation for this turn. */
  escalationApproved?: boolean;
  /** Set when an escalation was just declined (by the user, or because the run is headless). */
  escalationDeclined?: boolean;
  /** Aliases that refused a request this turn; they're skipped until the next prompt. */
  refused?: string[];
  /** The last call was refused: retry on another model now. */
  refusalRetry?: boolean;
  /** The user asked to escalate now (`/up`, the Escalate now button): one step up from where the session is. */
  escalateNow?: boolean;
  /** A subagent invocation's own budget and what it (and its subagents) spent so far. */
  invocationBudget?: { agent: string; limitUsd: number; spentUsd: number };
  /**
   * The session holds content that must never reach a remote model (a
   * `privacy.localOnlyPaths` match, or a secret under `privacy.secrets:
   * block`). Wins over every rule, including an explicit remote request.
   */
  privacy?: { reason: string };
}

export type RouteDecision =
  | {
      kind: 'route';
      model: ModelInfo;
      rule: string;
      reason: string;
      /** True when this decision moves the turn up the escalation ladder. */
      escalated: boolean;
      /**
       * The step the model is on: 0 for `routing.start`, k for the k-th
       * `routing.escalate` step. The engine reports it back through
       * `SignalTracker` so stickiness knows where the session is.
       */
      step: number;
    }
  | { kind: 'ask'; target: ModelInfo; rule: string; reason: string }
  | { kind: 'block'; rule: string; reason: string };
