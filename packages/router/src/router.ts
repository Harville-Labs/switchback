/**
 * Decides, per model call, which model runs it.
 *
 * The router is pure: it takes a snapshot of everything relevant (preferences,
 * agent pins, provider health, quality signals, spend) and returns a decision
 * with a human-readable reason. The engine owns all I/O. This keeps routing
 * explainable in the UI and exhaustively testable.
 *
 * Roles (ADR 0015): step 0 is `routing.start`, and steps 1..n are
 * `routing.escalate`. Any model can be on any step; whether it's local or
 * remote only matters to the guards (privacy, `allowRemote`, budgets) and to
 * `ask` prompts, which are about spending money.
 *
 * Pipeline: the first matching rule picks a target, then guards may redirect
 * it. See docs/routing.md.
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
  /** Per-turn override from the user (`/remote`, `--route local`, VS Code toggle): a tier filter. */
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
  /** Aliases that refused a request this turn; they're skipped until the next prompt. */
  refused?: string[];
  /** The last call was refused: retry on another model now. */
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
       * The step the model is on: 0 for `routing.start`, k for the k-th
       * `routing.escalate` step. The engine reports it back through
       * `SignalTracker` so stickiness knows where the session is.
       */
      step: number;
    }
  | { kind: 'ask'; target: ModelInfo; rule: string; reason: string }
  | { kind: 'block'; rule: string; reason: string };

type Routed = Extract<RouteDecision, { kind: 'route' }>;
type Blocked = Extract<RouteDecision, { kind: 'block' }>;

/** What `choose` picked from a chain, and why if it wasn't the first entry. */
interface Choice {
  model: ModelInfo | undefined;
  detour?: { rule: string; reason: string };
  fits: boolean;
}

/** A model on a step of the ladder. */
interface Rung {
  choice: Choice;
  step: number;
}

/** One decision's inputs, with refused aliases already removed from every step. */
interface Context {
  input: RouteInput;
  tokens: number;
  steps: string[][];
  /** Remote models may be used: `allowRemote` and no private content. */
  remoteOk: boolean;
}

export class Router {
  constructor(
    private readonly config: RoutingConfig,
    private readonly models: (alias: string) => ModelInfo | undefined,
  ) {}

  decide(input: RouteInput): RouteDecision {
    const refused = new Set(input.refused ?? []);
    const ctx: Context = {
      input,
      tokens: input.estimatedInputTokens,
      steps: [this.config.start, ...this.config.escalate].map((chain) =>
        chain.filter((a) => !refused.has(a)),
      ),
      remoteOk: this.config.allowRemote && !input.privacy,
    };
    const picked = input.refusalRetry ? this.retryAfterRefusal(ctx) : this.pick(ctx);
    if (picked.kind !== 'route') return picked;
    return this.guard(ctx, picked);
  }

  /** The step whose chain lists `alias` (as configured), or 0. */
  stepOf(alias: string): number {
    const i = [this.config.start, ...this.config.escalate].findIndex((c) => c.includes(alias));
    return Math.max(0, i);
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

  /** `choose` among the aliases of a step that the guards would allow. */
  private chooseAllowed(ctx: Context, step: number, tier?: Tier): Choice {
    const aliases = (ctx.steps[step] ?? []).filter((a) => {
      const m = this.models(a);
      return m && (m.tier === 'local' || ctx.remoteOk) && (!tier || m.tier === tier);
    });
    return this.choose(aliases, ctx.tokens);
  }

  /**
   * The next step above `from` with an allowed model that's up and fits.
   * Steps that are down, too small, or remote when remote isn't allowed are skipped.
   */
  private climb(ctx: Context, from: number, remoteOk = ctx.remoteOk): Rung | undefined {
    const scoped = { ...ctx, remoteOk };
    for (let step = from + 1; step < ctx.steps.length; step++) {
      const choice = this.chooseAllowed(scoped, step);
      if (choice.model?.available && choice.fits) return { choice, step };
    }
    return undefined;
  }

  /** The allowed, available model above `from` with the largest context window. */
  private largestAbove(ctx: Context, from: number): Rung | undefined {
    let best: Rung | undefined;
    for (let step = from + 1; step < ctx.steps.length; step++)
      for (const alias of ctx.steps[step] ?? []) {
        const m = this.models(alias);
        if (!m?.available || (m.tier === 'remote' && !ctx.remoteOk)) continue;
        if (!best?.choice.model || m.contextWindow > best.choice.model.contextWindow)
          best = { choice: { model: m, fits: false }, step };
      }
    return best;
  }

  /** The model on a step the session is already on, if it's allowed and up. */
  private rungAt(ctx: Context, step: number): Choice | undefined {
    const choice = this.chooseAllowed(ctx, step);
    return choice.model?.available ? choice : undefined;
  }

  /** The first model of a tier in role order: up and fitting, else up, else configured. */
  private ofTier(ctx: Context, tier: Tier): Rung | undefined {
    const all = ctx.steps.flatMap((chain, step) =>
      chain.flatMap((a) => {
        const m = this.models(a);
        return m && m.tier === tier ? [{ m, step }] : [];
      }),
    );
    const hit =
      all.find((x) => x.m.available && this.fits(x.m, ctx.tokens)) ??
      all.find((x) => x.m.available) ??
      all[0];
    return hit && { choice: { model: hit.m, fits: this.fits(hit.m, ctx.tokens) }, step: hit.step };
  }

  /** The local model nearest `from`: that step, then lower steps, then higher ones. */
  private nearestLocal(ctx: Context, from: number): Rung | undefined {
    const order = [
      ...Array.from({ length: from + 1 }, (_, i) => from - i),
      ...Array.from({ length: Math.max(0, ctx.steps.length - from - 1) }, (_, i) => from + 1 + i),
    ];
    for (const step of order) {
      const choice = this.chooseAllowed({ ...ctx, remoteOk: false }, step, 'local');
      if (choice.model?.available) return { choice, step };
    }
    return undefined;
  }

  private route(
    choice: Choice,
    rule: string,
    reason: string,
    escalated = false,
    step = 0,
  ): Routed | Blocked {
    const model = choice.model;
    if (!model)
      return {
        kind: 'block',
        rule,
        reason: `${reason}, but no model is configured for it; run \`switchback init\``,
      };
    // A detour within the step (another server was down or too small) is the
    // more specific explanation, so it names the rule.
    return choice.detour
      ? {
          kind: 'route',
          model,
          rule: choice.detour.rule,
          reason: `${reason}; ${choice.detour.reason}`,
          escalated,
          step,
        }
      : { kind: 'route', model, rule, reason, escalated, step };
  }

  /** A refused call retries on another model of the same step, else the next step up. */
  private retryAfterRefusal(ctx: Context): RouteDecision {
    const declined = ctx.input.refused?.at(-1) ?? 'the model';
    const from = this.stepOf(declined);
    const same = this.chooseAllowed(ctx, from);
    const rung = same.model?.available ? { choice: same, step: from } : this.climb(ctx, from);
    if (!rung?.choice.model)
      return {
        kind: 'block',
        rule: 'refusal-fallback',
        reason: `${declined} declined the request and no other model is configured to take it`,
      };
    return this.route(
      { ...rung.choice, detour: undefined },
      'refusal-fallback',
      `${declined} declined the request; retrying on ${rung.choice.model.alias}`,
      false,
      rung.step,
    );
  }

  private pick(ctx: Context): RouteDecision {
    const { input } = ctx;
    const start = this.choose(ctx.steps[0] ?? [], ctx.tokens);
    const at = input.signals.stickyTurns > 0 ? input.signals.escalationStep : 0;
    const byTier = (tier: Tier, rule: string, reason: string): Routed | Blocked => {
      const rung = this.ofTier(ctx, tier);
      if (!rung)
        return {
          kind: 'block',
          rule,
          reason: `${reason}, but no ${tier} model is in routing.start or routing.escalate; run \`switchback init\``,
        };
      return this.route(rung.choice, rule, reason, false, rung.step);
    };

    // 1. Explicit user override for this turn always wins; so does a declined escalation.
    if (input.preference === 'local')
      return byTier('local', 'user-override', 'user requested local');
    if (input.escalationDeclined) {
      const here = at > 0 ? this.rungAt(ctx, at) : undefined;
      const stay = here ?? start;
      return this.route(
        stay,
        'escalation-declined',
        `escalation was declined; staying on ${stay.model?.alias ?? 'the current model'}`,
        false,
        here ? at : 0,
      );
    }
    if (input.preference === 'remote')
      return byTier('remote', 'user-override', 'user requested remote');

    // 2. Agent pins: a specific model alias, or a tier.
    if (input.agent.model) {
      const pinned = this.models(input.agent.model);
      if (pinned)
        return this.route(
          { model: pinned, fits: true },
          'agent-pin',
          `agent "${input.agent.name}" pins ${pinned.alias}`,
          false,
          this.stepOf(pinned.alias),
        );
    }
    // A tier pin is a preference: if no model of that tier is in a role, route
    // normally rather than failing (e.g. `explore` on an all-remote setup).
    for (const tier of ['local', 'remote'] as const)
      if (input.agent.route === tier && this.ofTier(ctx, tier))
        return byTier(tier, 'agent-pin', `agent "${input.agent.name}" runs ${tier}`);

    // 3-6. Context overflow, stickiness, the classifier, and quality signals.
    const escalated = this.escalate(ctx, start, at);
    if (escalated) return escalated;

    // 7. Default: the start chain, or the first step if there is none.
    if (start.model) return this.route(start, 'default', 'the start model');
    const first = this.climb(ctx, 0);
    if (first)
      return this.route(
        first.choice,
        'default',
        'no start model configured; using the first escalation step',
        false,
        first.step,
      );
    return {
      kind: 'block',
      rule: 'default',
      reason: 'no model is configured (routing.start is empty); run `switchback init`',
    };
  }

  /**
   * The escalation rules, in priority order. Each escalation climbs one step
   * from where the session is (`at`). Remote steps follow `escalation.policy`
   * and the privacy rule; local steps cost nothing, so they never ask.
   */
  private escalate(ctx: Context, start: Choice, at: number): RouteDecision | undefined {
    const { input, tokens } = ctx;
    const policy = this.config.escalation.policy;
    const total = ctx.steps.length - 1;
    const where = (rung: Rung, reason: string) =>
      total > 1
        ? `${reason}; escalating to ${rung.choice.model?.alias} (step ${rung.step} of ${total})`
        : reason;
    /** Move up to `rung`, asking first when it's remote and the policy says so. */
    const go = (rung: Rung, rule: string, reason: string): RouteDecision | undefined => {
      const model = rung.choice.model;
      if (!input.escalationApproved) {
        // `off` stops quality escalations entirely; `ask` only guards spending money.
        if (policy === 'off') return undefined;
        if (policy === 'ask' && model?.tier === 'remote')
          return { kind: 'ask', target: model, rule, reason };
      }
      return this.route(rung.choice, rule, where(rung, reason), true, rung.step);
    };
    /** Climb from `from`; with only remote steps above, a private session explains why it stays. */
    const next = (from: number, rule: string, reason: string) => {
      const rung = this.climb(ctx, from);
      if (rung) return go(rung, rule, reason);
      if (input.privacy && this.config.allowRemote && this.climb(ctx, from, true))
        return this.privateLocal(ctx, from, reason);
      return undefined;
    };

    // 3. Hard limits: the model the session is on can't take this prompt at all.
    const current = at > 0 ? this.rungAt(ctx, at) : start;
    if (current?.model && !current.fits) {
      const reason = `~${tokens} tokens exceeds ${Math.round(this.config.escalation.contextHeadroom * 100)}% of ${current.model.alias}'s window (${current.model.contextWindow})`;
      const rung = this.climb(ctx, at);
      if (rung)
        return this.route(
          { ...rung.choice, detour: undefined },
          'context-overflow',
          where(rung, reason),
          true,
          rung.step,
        );
      // Nothing above fits: the biggest window above is still the best chance.
      const biggest = this.largestAbove(ctx, at);
      if (
        biggest &&
        biggest.choice.model &&
        biggest.choice.model.contextWindow > current.model.contextWindow
      )
        return this.route(
          biggest.choice,
          'context-overflow',
          where(biggest, reason),
          true,
          biggest.step,
        );
      if (input.privacy && this.config.allowRemote && this.climb(ctx, at, true))
        return this.privateLocal(ctx, at, reason);
    }

    const s = input.signals;
    const why = this.qualityProblem(s);

    // 4. Stickiness: stay on the step the last escalation reached, unless the
    // model there is struggling too and there's a step above it.
    if (at > 0) {
      if (why && policy !== 'off') {
        const higher = next(at, 'escalation', why);
        if (higher) return higher;
      }
      const here = this.rungAt(ctx, at);
      if (here)
        return this.route(
          here,
          'sticky',
          `recently escalated to ${here.model?.alias} (${s.stickyTurns} turn${s.stickyTurns === 1 ? '' : 's'} left)`,
          false,
          at,
        );
    }

    // 5. The classifier rated the prompt too hard for the start model.
    const d = input.difficulty;
    const c = this.config.classifier;
    if (d && c && LEVEL[d.level] >= LEVEL[c.escalateOn]) {
      const reason = `classifier rated the prompt ${d.level}${d.reason ? `: ${d.reason}` : ''}`;
      const decision = next(0, 'classifier', reason);
      if (decision) return decision;
    }

    // 6. Quality signals from the model that ran the last call.
    if (why) return next(0, 'escalation', why);
    return undefined;
  }

  /** A would-be remote call kept local for privacy; blocked when no local model can take it. */
  private privateLocal(ctx: Context, from: number, why?: string): Routed | Blocked {
    const privacy = ctx.input.privacy ?? { reason: 'private content' };
    const reason = `${why ? `${why}, but ` : ''}this session holds private content (${privacy.reason}), which never leaves this machine`;
    const local = this.nearestLocal(ctx, from);
    if (!local?.choice.model)
      return {
        kind: 'block',
        rule: 'privacy',
        reason: `${reason}, and no local model is available`,
      };
    return {
      kind: 'route',
      model: local.choice.model,
      rule: 'privacy',
      reason: `${reason}; staying local`,
      escalated: false,
      step: local.step,
    };
  }

  private qualityProblem(s: SignalSnapshot): string | undefined {
    const c = this.config.escalation;
    if (s.turnFailed) return 'the model failed to complete the last turn';
    if (s.loopDetected) return 'the model is repeating the same tool call';
    if (s.malformedToolCalls >= c.maxMalformedToolCalls)
      return `${s.malformedToolCalls} malformed tool calls`;
    if (s.consecutiveToolErrors >= c.maxConsecutiveToolErrors)
      return `${s.consecutiveToolErrors} consecutive tool errors`;
    return undefined;
  }

  private guard(ctx: Context, decision: Routed): RouteDecision {
    const { input } = ctx;
    let d = decision;
    /** Redirect a remote decision to the nearest local model, or block. */
    const toLocal = (rule: string, reason: string, block: boolean): Routed | Blocked => {
      const local = block ? undefined : this.nearestLocal(ctx, d.step);
      if (!local?.choice.model) return { kind: 'block', rule, reason };
      return {
        kind: 'route',
        model: local.choice.model,
        rule,
        reason: `${reason}; using ${local.choice.model.alias}`,
        escalated: false,
        step: local.step,
      };
    };

    // Privacy first: nothing else may send private content to a remote model.
    if (d.model.tier === 'remote' && input.privacy) return this.privateLocal(ctx, d.step);

    // Remote models turned off: an explicit remote request is refused, anything else stays local.
    if (d.model.tier === 'remote' && !this.config.allowRemote)
      return toLocal(
        'remote-off',
        'remote models are turned off (routing.allowRemote)',
        input.preference === 'remote',
      );

    // A subagent's own budget: once spent, it continues locally or stops.
    const ib = input.invocationBudget;
    if (d.model.tier === 'remote' && ib && ib.spentUsd >= ib.limitUsd) {
      const over = `subagent "${ib.agent}" spent $${ib.spentUsd.toFixed(2)} of its $${ib.limitUsd.toFixed(2)} budget`;
      const r = toLocal('agent-budget', over, false);
      if (r.kind !== 'route') return r;
      d = r;
    }

    // Budget: never overspend unless the user explicitly asked for remote.
    if (d.model.tier === 'remote' && input.preference !== 'remote') {
      const over = this.overBudget(input.spend);
      if (over) {
        const r = toLocal('budget', over, this.config.budget.onExceeded === 'block');
        if (r.kind !== 'route') return r;
        d = r;
      }
    }

    // Availability: every model on the chosen step is down, so try the nearest other step.
    if (!d.model.available) {
      const unavailable = `${d.model.alias} is unavailable`;
      if (this.config.fallback === 'none')
        return { kind: 'block', rule: 'fallback', reason: unavailable };
      const other = this.nearestUp(ctx, d.step);
      if (!other?.choice.model) {
        // Only a remote model could take it: say that privacy is why it can't.
        if (
          input.privacy &&
          this.config.allowRemote &&
          this.nearestUp({ ...ctx, remoteOk: true }, d.step)
        )
          return this.privateLocal(ctx, d.step, unavailable);
        return { kind: 'block', rule: 'fallback', reason: unavailable };
      }
      return {
        kind: 'route',
        model: other.choice.model,
        rule: 'fallback',
        reason: `${unavailable}; using ${other.choice.model.alias}`,
        escalated: false,
        step: other.step,
      };
    }
    return d;
  }

  /**
   * For an outage: the nearest other step with an allowed model that's up,
   * higher steps first, then lower. Remote models over budget don't count.
   */
  private nearestUp(ctx: Context, from: number): Rung | undefined {
    const over = this.overBudget(ctx.input.spend) !== undefined;
    const scoped = { ...ctx, remoteOk: ctx.remoteOk && !over };
    const order = [
      ...Array.from({ length: Math.max(0, ctx.steps.length - from - 1) }, (_, i) => from + 1 + i),
      ...Array.from({ length: from }, (_, i) => from - 1 - i),
    ];
    for (const step of order) {
      const choice = this.chooseAllowed(scoped, step);
      if (choice.model?.available) return { choice: { ...choice, detour: undefined }, step };
    }
    return undefined;
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
