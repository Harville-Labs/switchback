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
import type { ModelRef, RoutePreference, Tier } from '@switchback/protocol';
import type { RoutingConfig } from './config.ts';
import type { SignalSnapshot } from './signals.ts';

export interface ModelInfo {
  alias: string;
  ref: ModelRef;
  tier: Tier;
  contextWindow: number;
  available: boolean;
}

/** A classifier's rating of the user's prompt. */
export interface Difficulty {
  level: 'easy' | 'medium' | 'hard';
  reason: string;
}

const LEVEL = { easy: 0, medium: 1, hard: 2 } as const;

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
  /** The classifier's rating of this turn's prompt (first call of a turn only). */
  difficulty?: Difficulty;
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
       * The ladder step the model is on: 0 for the local chain (and anything
       * routed outside the ladder), then each `escalation.via` model, then the
       * remote chain. The engine reports it back through `SignalTracker`.
       */
      step: number;
    }
  | { kind: 'ask'; target: ModelInfo; rule: string; reason: string }
  | { kind: 'block'; rule: string; reason: string };

/** A step the router can escalate to, and its index on the ladder. */
interface Rung {
  choice: Choice;
  step: number;
}

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
        step: this.remoteStep,
      } as const;
      return this.guard(input, picked, local, remoteChain);
    }
    const picked = this.pick(input, local, remote, remoteChain);
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

  /** The remote chain's step: after the local chain and every `escalation.via` model. */
  private get remoteStep(): number {
    return this.config.escalation.via.length + 1;
  }

  /**
   * The next step above `from` that can take this turn. `escalation.via`
   * models that are down or too small are skipped; the remote chain is
   * returned as configured, for the availability guard to handle. Remote
   * models are left out when `allowRemote` is false.
   */
  private climb(
    from: number,
    tokens: number,
    remoteChain: string[],
    allowRemote: boolean,
  ): Rung | undefined {
    const via = this.config.escalation.via;
    for (let step = from + 1; step <= via.length; step++) {
      const choice = this.choose([via[step - 1] ?? ''], tokens);
      const m = choice.model;
      if (!m || !m.available || !choice.fits) continue;
      if (m.tier === 'remote' && !allowRemote) continue;
      return { choice, step };
    }
    if (!allowRemote || from >= this.remoteStep) return undefined;
    const choice = this.choose(remoteChain, tokens);
    return choice.model ? { choice, step: this.remoteStep } : undefined;
  }

  /** The model for a step the session is already on (stickiness). */
  private rungAt(step: number, tokens: number, remoteChain: string[]): Choice | undefined {
    if (step <= 0) return undefined;
    if (step >= this.remoteStep) return this.choose(remoteChain, tokens);
    const choice = this.choose([this.config.escalation.via[step - 1] ?? ''], tokens);
    return choice.model?.available ? choice : undefined;
  }

  private pick(
    input: RouteInput,
    local: Choice,
    remote: Choice,
    remoteChain: string[],
  ): RouteDecision {
    const route = (choice: Choice, rule: string, reason: string, escalated = false, step = 0) => {
      const model = choice.model;
      if (!model)
        return {
          kind: 'block',
          rule,
          reason: `${reason}, but no model is configured for it; run \`switchback init\``,
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
            step,
          } as const)
        : ({ kind: 'route', model, rule, reason, escalated, step } as const);
    };

    // 1. Explicit user override for this turn always wins; so does a declined escalation.
    if (input.preference === 'local') return route(local, 'user-override', 'user requested local');
    if (input.escalationDeclined)
      return route(local, 'escalation-declined', 'escalation was declined; staying local');
    if (input.preference === 'remote')
      return route(remote, 'user-override', 'user requested remote');

    // 2. Global mode. Local-only can still climb through local `escalation.via` models.
    if (this.config.mode === 'local-only')
      return (
        this.escalate(input, local, remoteChain, route, false) ??
        route(local, 'mode', 'routing mode is local-only')
      );
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
      return route(
        remote,
        'agent-pin',
        `agent "${input.agent.name}" runs remote`,
        false,
        this.remoteStep,
      );

    // 4-7. Context overflow, stickiness, the classifier, and quality signals.
    const escalated = this.escalate(input, local, remoteChain, route, true);
    if (escalated) return escalated;

    // 8. Default: local first.
    return local.model
      ? route(local, 'default', 'local by default')
      : route(
          remote,
          'default',
          'no local model configured (run `switchback init`)',
          false,
          this.remoteStep,
        );
  }

  /**
   * The escalation rules, in priority order. Each escalation climbs one step
   * from where the session is. Remote steps follow `escalation.policy` and the
   * privacy rule; local steps cost nothing, so they never ask.
   */
  private escalate(
    input: RouteInput,
    local: Choice,
    remoteChain: string[],
    route: (
      choice: Choice,
      rule: string,
      reason: string,
      escalated?: boolean,
      step?: number,
    ) => RouteDecision,
    allowRemote: boolean,
  ): RouteDecision | undefined {
    const tokens = input.estimatedInputTokens;
    const policy = this.config.escalation.policy;
    // Private content may climb through local models but never leaves the machine.
    const remoteOk = allowRemote && !input.privacy;
    const total = this.remoteStep;
    const onLadder = (rung: Rung, reason: string) =>
      rung.step < total
        ? `${reason}; escalating to ${rung.choice.model?.alias} (step ${rung.step} of ${total})`
        : reason;
    /** Move up to `rung`, asking first when it's remote and the policy says so. */
    const go = (rung: Rung, rule: string, reason: string, approvalNeeded: boolean) => {
      const model = rung.choice.model;
      if (approvalNeeded && !input.escalationApproved) {
        // `off` stops quality escalations entirely; `ask` only guards spending money.
        if (policy === 'off') return undefined;
        if (policy === 'ask' && model?.tier === 'remote')
          return { kind: 'ask', target: model, rule, reason } as const;
      }
      return route(rung.choice, rule, onLadder(rung, reason), true, rung.step);
    };
    /** Climb from `from`; with nowhere to go, a private session explains why it stays. */
    const next = (from: number, rule: string, reason: string, approvalNeeded: boolean) => {
      const rung = this.climb(from, tokens, remoteChain, remoteOk);
      if (rung) return go(rung, rule, reason, approvalNeeded);
      if (input.privacy && allowRemote && this.climb(from, tokens, remoteChain, true))
        return this.privateLocal(input.privacy, local, reason);
      return undefined;
    };

    // 4. Hard limits: no local model can take this turn at all.
    if (local.model && !local.fits) {
      const largest = Math.max(
        ...this.config.local.flatMap((a) => this.models(a)?.contextWindow ?? []),
      );
      const reason = `~${tokens} tokens exceeds ${Math.round(this.config.escalation.contextHeadroom * 100)}% of the largest local window (${largest})`;
      const rung = this.climb(0, tokens, remoteChain, remoteOk);
      if (rung)
        return route(
          { ...rung.choice, detour: undefined },
          'context-overflow',
          onLadder(rung, reason),
          true,
          rung.step,
        );
      if (input.privacy && allowRemote) return this.privateLocal(input.privacy, local, reason);
      if (allowRemote)
        return route({ model: undefined, fits: false }, 'context-overflow', reason, true, total);
      return undefined;
    }

    const s = input.signals;
    const at = s.stickyTurns > 0 ? s.escalationStep : 0;
    const why = this.qualityProblem(s);

    // 5. Stickiness: stay on the step the last escalation reached, unless the
    // model there is struggling too and there's a step above it.
    if (at > 0) {
      if (why && policy !== 'off') {
        const higher = next(at, 'escalation', why, true);
        if (higher) return higher;
      }
      const here = this.rungAt(at, tokens, remoteChain);
      const allowed = here?.model && (here.model.tier === 'local' || remoteOk);
      if (here && allowed)
        return route(
          here,
          'sticky',
          `recently escalated to ${here.model?.alias} (${s.stickyTurns} turn${s.stickyTurns === 1 ? '' : 's'} left)`,
          false,
          at,
        );
    }

    // 6. The classifier rated the prompt too hard for the local model.
    const d = input.difficulty;
    const c = this.config.classifier;
    if (d && c && LEVEL[d.level] >= LEVEL[c.escalateOn]) {
      const reason = `classifier rated the prompt ${d.level}${d.reason ? `: ${d.reason}` : ''}`;
      const decision = next(0, 'classifier', reason, true);
      if (decision) return decision;
    }

    // 7. Quality signals from the local model.
    if (why) return next(0, 'escalation', why, true);
    return undefined;
  }

  /** A would-be remote turn kept local for privacy; blocked when no local model can take it. */
  private privateLocal(
    privacy: { reason: string },
    local: Choice,
    why?: string,
  ): Extract<RouteDecision, { kind: 'route' | 'block' }> {
    const reason = `${why ? `${why}, but ` : ''}this session holds private content (${privacy.reason}), which never leaves this machine`;
    if (!local.model?.available)
      return {
        kind: 'block',
        rule: 'privacy',
        reason: `${reason}, and no local model is available`,
      };
    return {
      kind: 'route',
      model: local.model,
      rule: 'privacy',
      reason: `${reason}; staying local`,
      escalated: false,
      step: 0,
    };
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

    // Privacy first: nothing else may send private content to a remote model.
    if (d.model.tier === 'remote' && input.privacy) return this.privateLocal(input.privacy, local);

    // A subagent's own budget: once spent, it continues locally or stops.
    const ib = input.invocationBudget;
    if (d.model.tier === 'remote' && ib && ib.spentUsd >= ib.limitUsd) {
      const over = `subagent "${ib.agent}" spent $${ib.spentUsd.toFixed(2)} of its $${ib.limitUsd.toFixed(2)} budget`;
      if (!local.model?.available) return { kind: 'block', rule: 'agent-budget', reason: over };
      d = {
        ...d,
        model: local.model,
        rule: 'agent-budget',
        reason: `${over}; continuing locally`,
        escalated: false,
        step: 0,
      };
    }

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
            step: 0,
          };
      }
    }

    // Availability: every model in the chosen tier is down, so fall back across tiers.
    if (!d.model.available && input.privacy) return this.privateLocal(input.privacy, local);
    if (!d.model.available) {
      const fb = this.config.fallback;
      const other =
        d.model.tier === 'local'
          ? // local-only means no remote spend, even when the local server is down.
            fb.onLocalUnavailable === 'remote' && this.config.mode !== 'local-only'
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
          step: other.tier === 'remote' ? this.remoteStep : 0,
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
