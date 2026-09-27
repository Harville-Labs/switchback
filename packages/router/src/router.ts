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
  /** Set when an escalation was just declined (by the user, or because the run is headless). */
  escalationDeclined?: boolean;
  /** Remote aliases that refused a request this turn; they're skipped until the next prompt. */
  refused?: string[];
  /** The last call was refused: retry on the next remote model now. */
  refusalRetry?: boolean;
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

/** What `choose` picked from a chain, and why if it wasn't the first entry. */
interface Choice {
  model: ModelInfo | undefined;
  detour?: { rule: string; reason: string };
  fits: boolean;
}

export class Router {
  constructor(
    private readonly config: RoutingConfig,
    private readonly models: (alias: string) => ModelInfo | undefined,
  ) {}

  decide(input: RouteInput): RouteDecision {
    const tokens = input.estimatedInputTokens;
    const refused = new Set(input.refused ?? []);
    const remoteChain = this.config.remote.filter((a) => !refused.has(a));
    const local = this.choose(this.config.local, tokens);
    const remote = this.choose(remoteChain, tokens);
    if (input.refusalRetry) {
      const declined = input.refused?.at(-1) ?? 'the remote model';
      if (!remote.model)
        return {
          kind: 'block',
          rule: 'refusal-fallback',
          reason: `${declined} declined the request and no other remote model is configured`,
        };
      const picked = {
        kind: 'route',
        model: remote.model,
        rule: 'refusal-fallback',
        reason: `${declined} declined the request; retrying on ${remote.model.alias}`,
        escalated: false,
      } as const;
      return this.guard(input, picked, local, remoteChain);
    }
    const picked = this.pick(input, local, remote);
    if (picked.kind !== 'route') return picked;
    return this.guard(input, picked, local, remoteChain);
  }

  /**
   * The first model in a chain that is reachable and fits the prompt; else the
   * first reachable one; else the first configured one (which the
   * availability guard then handles). Aliases with no model are skipped.
   */
  private choose(aliases: string[], tokens: number): Choice {
    const chain = aliases.flatMap((a) => this.models(a) ?? []);
    const primary = chain[0];
    if (!primary) return { model: undefined, fits: false };
    const up = chain.filter((m) => m.available);
    const model = up.find((m) => this.fits(m, tokens)) ?? up[0] ?? primary;
    const fits = this.fits(model, tokens);
    if (model === primary) return { model, fits };
    const detour = !primary.available
      ? { rule: 'fallback', reason: `${primary.alias} is unavailable; using ${model.alias}` }
      : {
          rule: 'context-fit',
          reason: `~${tokens} tokens exceeds ${primary.alias}'s window; using ${model.alias} (${model.contextWindow})`,
        };
    return { model, detour, fits };
  }

  private fits(m: ModelInfo, tokens: number): boolean {
    return tokens <= m.contextWindow * this.config.escalation.contextHeadroom;
  }

  private pick(input: RouteInput, local: Choice, remote: Choice): RouteDecision {
    const route = (choice: Choice, rule: string, reason: string, escalated = false) => {
      const model = choice.model;
      if (!model)
        return {
          kind: 'block',
          rule,
          reason: `${reason}, but no model is configured for it; run \`harness init\``,
        } as const;
      // A detour within the tier (another server was down or too small) is the
      // more specific explanation, so it names the rule.
      return choice.detour
        ? ({
            kind: 'route',
            model,
            rule: choice.detour.rule,
            reason: `${reason}; ${choice.detour.reason}`,
            escalated,
          } as const)
        : ({ kind: 'route', model, rule, reason, escalated } as const);
    };

    // 1. Explicit user override for this turn always wins; so does a declined escalation.
    if (input.preference === 'local') return route(local, 'user-override', 'user requested local');
    if (input.escalationDeclined)
      return route(local, 'escalation-declined', 'escalation was declined; staying local');
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
        return route(
          { model: pinned, fits: true },
          'agent-pin',
          `agent "${input.agent.name}" pins ${pinned.alias}`,
        );
    }
    // A tier pin is a preference: if that tier isn't configured, route normally
    // rather than failing (e.g. `explore` on a remote-only setup).
    if (input.agent.route === 'local' && local.model)
      return route(local, 'agent-pin', `agent "${input.agent.name}" runs local`);
    if (input.agent.route === 'remote' && remote.model)
      return route(remote, 'agent-pin', `agent "${input.agent.name}" runs remote`);

    // 4. Hard limits: no local model can take this turn at all.
    if (local.model && !local.fits) {
      const largest = Math.max(
        ...this.config.local.flatMap((a) => this.models(a)?.contextWindow ?? []),
      );
      return route(
        { ...remote, detour: undefined },
        'context-overflow',
        `~${input.estimatedInputTokens} tokens exceeds ${Math.round(this.config.escalation.contextHeadroom * 100)}% of the largest local window (${largest})`,
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
    if (why && remote.model) {
      const policy = this.config.escalation.policy;
      if (policy === 'auto' || input.escalationApproved)
        return route(remote, 'escalation', why, true);
      if (policy === 'ask')
        return { kind: 'ask', target: remote.model, rule: 'escalation', reason: why };
    }

    // 7. Default: local first.
    return local.model
      ? route(local, 'default', 'local by default')
      : route(remote, 'default', 'no local model configured (run `harness init`)');
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
    local: Choice,
    remoteChain: string[],
  ): RouteDecision {
    let d = decision;

    // Budget: never overspend unless the user explicitly asked for remote.
    if (d.model.tier === 'remote' && input.preference !== 'remote') {
      const over = this.overBudget(input.spend);
      if (over) {
        if (this.config.budget.onExceeded === 'block')
          return { kind: 'block', rule: 'budget', reason: over };
        if (local.model)
          d = {
            ...d,
            model: local.model,
            rule: 'budget',
            reason: `${over}; staying local`,
            escalated: false,
          };
      }
    }

    // Availability: every model in the chosen tier is down, so fall back across tiers.
    if (!d.model.available) {
      const fb = this.config.fallback;
      const other =
        d.model.tier === 'local'
          ? fb.onLocalUnavailable === 'remote'
            ? this.choose(remoteChain, input.estimatedInputTokens).model
            : undefined
          : fb.onRemoteUnavailable === 'local'
            ? local.model
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
