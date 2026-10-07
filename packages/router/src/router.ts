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
import type { Tier } from '@switchback/protocol';
import type { RoutingConfig } from './config.ts';
import { type Choice, type Context, Ladder, type Rung } from './ladder.ts';
import { budgetReached, ladderSteps, stepOf } from './roles.ts';
import type { ModelInfo, RouteDecision, RouteInput } from './route-types.ts';
import type { SignalSnapshot } from './signals.ts';

export type { ModelInfo, RouteDecision, RouteInput } from './route-types.ts';

type Routed = Extract<RouteDecision, { kind: 'route' }>;
type Blocked = Extract<RouteDecision, { kind: 'block' }>;

export class Router {
  private readonly ladder: Ladder;

  constructor(
    private readonly config: RoutingConfig,
    private readonly models: (alias: string) => ModelInfo | undefined,
  ) {
    this.ladder = new Ladder(config, models);
  }

  decide(input: RouteInput): RouteDecision {
    const refused = new Set(input.refused ?? []);
    const ctx: Context = {
      input,
      tokens: input.estimatedInputTokens,
      images: input.images ?? false,
      steps: ladderSteps(this.config).map((chain) => chain.filter((a) => !refused.has(a))),
      remoteOk: this.config.allowRemote && !input.privacy,
    };
    const picked = input.refusalRetry ? this.retryAfterRefusal(ctx) : this.pick(ctx);
    if (picked.kind !== 'route') return picked;
    return this.guard(ctx, picked);
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
    const from = stepOf(this.config, declined);
    const same = this.ladder.chooseAllowed(ctx, from);
    const rung = same.model?.available
      ? { choice: same, step: from }
      : this.ladder.climb(ctx, from);
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
    const start = this.ladder.choose(ctx.steps[0] ?? [], ctx);
    const at = input.signals.stickyTurns > 0 ? input.signals.escalationStep : 0;
    const byTier = (tier: Tier, rule: string, reason: string): Routed | Blocked => {
      const rung = this.ladder.ofTier(ctx, tier);
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
      const here = at > 0 ? this.ladder.rungAt(ctx, at) : undefined;
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
          stepOf(this.config, pinned.alias),
        );
    }
    // A tier pin is a preference: if no model of that tier is in a role, route
    // normally rather than failing (e.g. `explore` on an all-remote setup).
    for (const tier of ['local', 'remote'] as const)
      if (input.agent.route === tier && this.ladder.ofTier(ctx, tier))
        return byTier(tier, 'agent-pin', `agent "${input.agent.name}" runs ${tier}`);

    // 3-6. Context overflow, the user's escalation, stickiness, and quality signals.
    const escalated = this.escalate(ctx, start, at);
    if (escalated) return escalated;

    // 7. Default: the start chain, or the first step if there is none.
    if (start.model) return this.route(start, 'default', 'the start model');
    const first = this.ladder.climb(ctx, 0);
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
      const rung = this.ladder.climb(ctx, from);
      if (rung) return go(rung, rule, reason);
      if (input.privacy && this.config.allowRemote && this.ladder.climb(ctx, from, true))
        return this.privateLocal(ctx, from, reason);
      return undefined;
    };

    // 3. Hard limits: the model the session is on can't take this prompt at all.
    const current = at > 0 ? this.ladder.rungAt(ctx, at) : start;
    if (current?.model && !current.fits) {
      const reason = `~${tokens} tokens exceeds ${Math.round(this.config.escalation.contextHeadroom * 100)}% of ${current.model.alias}'s window (${current.model.contextWindow})`;
      const rung = this.ladder.climb(ctx, at);
      if (rung)
        return this.route(
          { ...rung.choice, detour: undefined },
          'context-overflow',
          where(rung, reason),
          true,
          rung.step,
        );
      // Nothing above fits: the biggest window above is still the best chance.
      const biggest = this.ladder.largestAbove(ctx, at);
      if (biggest?.choice.model && biggest.choice.model.contextWindow > current.model.contextWindow)
        return this.route(
          biggest.choice,
          'context-overflow',
          where(biggest, reason),
          true,
          biggest.step,
        );
      if (input.privacy && this.config.allowRemote && this.ladder.climb(ctx, at, true))
        return this.privateLocal(ctx, at, reason);
    }

    // 4. The user asked to escalate: one step up from where the session is. It's
    // their request, so a remote step doesn't ask; budgets and privacy still apply.
    if (input.escalateNow) {
      const reason = 'you asked to escalate';
      const rung = this.ladder.climb(ctx, at);
      if (rung)
        return this.route(rung.choice, 'user-escalation', where(rung, reason), true, rung.step);
      if (input.privacy && this.config.allowRemote && this.ladder.climb(ctx, at, true))
        return this.privateLocal(ctx, at, reason);
    }

    const s = input.signals;
    const why = this.qualityProblem(s);

    // 5. Stickiness: stay on the step the last escalation reached, unless the
    // model there is struggling too and there's a step above it.
    if (at > 0) {
      if (why && policy !== 'off') {
        const higher = next(at, 'escalation', why);
        if (higher) return higher;
      }
      const here = this.ladder.rungAt(ctx, at);
      if (here)
        return this.route(
          here,
          'sticky',
          `recently escalated to ${here.model?.alias} (${s.stickyTurns} turn${s.stickyTurns === 1 ? '' : 's'} left)`,
          false,
          at,
        );
    }

    // 6. Quality signals from the model that ran the last call.
    if (why) return next(0, 'escalation', why);
    return undefined;
  }

  /** A would-be remote call kept local for privacy; blocked when no local model can take it. */
  private privateLocal(ctx: Context, from: number, why?: string): Routed | Blocked {
    const privacy = ctx.input.privacy ?? { reason: 'private content' };
    const reason = `${why ? `${why}, but ` : ''}this session holds private content (${privacy.reason}), which never leaves this machine`;
    const local = this.ladder.nearestLocal(ctx, from);
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
      const local = block ? undefined : this.ladder.nearestLocal(ctx, d.step);
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
      const over = budgetReached(this.config.budget, input.spend);
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
      const other = this.ladder.nearestUp(ctx, d.step);
      if (!other?.choice.model) {
        // Only a remote model could take it: say that privacy is why it can't.
        if (
          input.privacy &&
          this.config.allowRemote &&
          this.ladder.nearestUp({ ...ctx, remoteOk: true }, d.step)
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
}
