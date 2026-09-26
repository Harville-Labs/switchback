/**
 * Decides, per model turn, whether to run locally or remotely.
 *
 * The router is pure: it takes a snapshot of everything relevant (preferences,
 * agent pins, provider health, quality signals, spend) and returns a decision
 * with a human-readable reason. The engine owns all I/O. This keeps routing
 * explainable in the UI and exhaustively testable.
 *
 * Pipeline: the first matching rule picks a target, then guards (budget,
 * availability) may redirect it. See docs/routing.md.
 */
import type { ModelRef, RoutePreference, Tier } from '@harness/protocol';
import type { RoutingConfig } from './config.ts';
import type { SignalSnapshot } from './signals.ts';

export interface ModelInfo {
  alias: string;
  ref: ModelRef;
  tier: Tier;
  contextWindow: number;
  available: boolean;
}

export interface RouteInput {
  /** Per-turn override from the user (`/remote`, `--route local`, VS Code toggle). */
  preference: RoutePreference;
  /** From the active agent's definition. */
  agent: { name: string; route: RoutePreference; model?: string };
  estimatedInputTokens: number;
  signals: SignalSnapshot;
  spend: { todayUsd: number; monthUsd: number };
  /** Set when the user already approved an escalation for this turn. */
  escalationApproved?: boolean;
}

export type RouteDecision =
  | {
      kind: 'route';
      model: ModelInfo;
      rule: string;
      reason: string;
      /** True when this decision moves a would-be-local turn to remote because of quality signals. */
      escalated: boolean;
    }
  | { kind: 'ask'; target: ModelInfo; rule: string; reason: string }
  | { kind: 'block'; rule: string; reason: string };

export class Router {
  constructor(
    private readonly config: RoutingConfig,
    private readonly models: (alias: string) => ModelInfo | undefined,
  ) {}

  decide(input: RouteInput): RouteDecision {
    const local = this.models(this.config.local);
    const remote = this.models(this.config.remote);
    const picked = this.pick(input, local, remote);
    if (picked.kind !== 'route') return picked;
    return this.guard(input, picked, local);
  }

  private pick(
    input: RouteInput,
    local: ModelInfo | undefined,
    remote: ModelInfo | undefined,
  ): RouteDecision {
    const route = (
      model: ModelInfo | undefined,
      rule: string,
      reason: string,
      escalated = false,
    ) =>
      model
        ? ({ kind: 'route', model, rule, reason, escalated } as const)
        : ({
            kind: 'block',
            rule,
            reason: `${reason}, but no model is configured for it`,
          } as const);

    // 1. Explicit user override for this turn always wins.
    if (input.preference === 'local') return route(local, 'user-override', 'user requested local');
    if (input.preference === 'remote')
      return route(remote, 'user-override', 'user requested remote');

    // 2. Global mode.
    if (this.config.mode === 'local-only')
      return route(local, 'mode', 'routing mode is local-only');
    if (this.config.mode === 'remote-only')
      return route(remote, 'mode', 'routing mode is remote-only');

    // 3. Agent pins: a specific model alias, or a tier.
    if (input.agent.model) {
      const pinned = this.models(input.agent.model);
      if (pinned)
        return route(pinned, 'agent-pin', `agent "${input.agent.name}" pins ${pinned.alias}`);
    }
    if (input.agent.route === 'local')
      return route(local, 'agent-pin', `agent "${input.agent.name}" runs local`);
    if (input.agent.route === 'remote')
      return route(remote, 'agent-pin', `agent "${input.agent.name}" runs remote`);

    // 4. Hard limits: the local model cannot take this turn at all.
    if (
      local &&
      input.estimatedInputTokens > local.contextWindow * this.config.escalation.contextHeadroom
    ) {
      return route(
        remote,
        'context-overflow',
        `~${input.estimatedInputTokens} tokens exceeds ${Math.round(this.config.escalation.contextHeadroom * 100)}% of ${local.alias}'s ${local.contextWindow} window`,
        true,
      );
    }

    // 5. Stickiness: stay remote for a few turns after an escalation.
    if (input.signals.stickyRemoteTurns > 0)
      return route(
        remote,
        'sticky',
        `recently escalated (${input.signals.stickyRemoteTurns} turns left)`,
      );

    // 6. Quality signals from the local model.
    const why = this.qualityProblem(input.signals);
    if (why && remote) {
      const policy = this.config.escalation.policy;
      if (policy === 'auto' || input.escalationApproved)
        return route(remote, 'escalation', why, true);
      if (policy === 'ask') return { kind: 'ask', target: remote, rule: 'escalation', reason: why };
    }

    // 7. Default: local first.
    return route(
      local ?? remote,
      'default',
      local ? 'local by default' : 'no local model configured',
    );
  }

  private qualityProblem(s: SignalSnapshot): string | undefined {
    const c = this.config.escalation;
    if (s.localTurnFailed) return 'local model failed to complete the last turn';
    if (s.loopDetected) return 'local model is repeating the same tool call';
    if (s.malformedToolCalls >= c.maxMalformedToolCalls)
      return `${s.malformedToolCalls} malformed tool calls from local model`;
    if (s.consecutiveToolErrors >= c.maxConsecutiveToolErrors)
      return `${s.consecutiveToolErrors} consecutive tool errors`;
    return undefined;
  }

  private guard(
    input: RouteInput,
    decision: Extract<RouteDecision, { kind: 'route' }>,
    local: ModelInfo | undefined,
  ): RouteDecision {
    let d = decision;

    // Budget: never overspend unless the user explicitly asked for remote.
    if (d.model.tier === 'remote' && input.preference !== 'remote') {
      const over = this.overBudget(input.spend);
      if (over) {
        if (this.config.budget.onExceeded === 'block')
          return { kind: 'block', rule: 'budget', reason: over };
        if (local)
          d = {
            ...d,
            model: local,
            rule: 'budget',
            reason: `${over}; staying local`,
            escalated: false,
          };
      }
    }

    // Availability: fall back across tiers when the chosen provider is down.
    if (!d.model.available) {
      const fb = this.config.fallback;
      const other =
        d.model.tier === 'local'
          ? fb.onLocalUnavailable === 'remote'
            ? this.models(this.config.remote)
            : undefined
          : fb.onRemoteUnavailable === 'local'
            ? local
            : undefined;
      if (other?.available && !(other.tier === 'remote' && this.overBudget(input.spend))) {
        return {
          kind: 'route',
          model: other,
          rule: 'fallback',
          reason: `${d.model.alias} is unavailable; using ${other.alias}`,
          escalated: false,
        };
      }
      return { kind: 'block', rule: 'fallback', reason: `${d.model.alias} is unavailable` };
    }
    return d;
  }

  private overBudget(spend: RouteInput['spend']): string | undefined {
    const b = this.config.budget;
    if (b.dailyUsd !== undefined && spend.todayUsd >= b.dailyUsd)
      return `daily remote budget of $${b.dailyUsd.toFixed(2)} reached`;
    if (b.monthlyUsd !== undefined && spend.monthUsd >= b.monthlyUsd)
      return `monthly remote budget of $${b.monthlyUsd.toFixed(2)} reached`;
    return undefined;
  }
}
