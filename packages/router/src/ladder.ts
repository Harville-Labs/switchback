/**
 * Moving along the escalation ladder: which model a step offers for a call,
 * and the steps above, below, or nearest that can take it. The router's rules
 * decide where to go; this finds what's there.
 */
import type { Tier } from '@switchback/protocol';
import type { RoutingConfig } from './config.ts';
import { budgetReached } from './roles.ts';
import type { ModelInfo, RouteInput } from './route-types.ts';

/** What `choose` picked from a chain, and why if it wasn't the first entry. */
export interface Choice {
  model: ModelInfo | undefined;
  detour?: { rule: string; reason: string };
  fits: boolean;
}

/** A model on a step of the ladder. */
export interface Rung {
  choice: Choice;
  step: number;
}

/** One decision's inputs, with refused aliases already removed from every step. */
export interface Context {
  input: RouteInput;
  tokens: number;
  images: boolean;
  steps: string[][];
  /** Remote models may be used: `allowRemote` and no private content. */
  remoteOk: boolean;
}

export class Ladder {
  constructor(
    private readonly config: RoutingConfig,
    private readonly models: (alias: string) => ModelInfo | undefined,
  ) {}

  /**
   * The first model in a chain that is reachable and fits the prompt (and,
   * when the conversation holds images, can see them); else the first that
   * is reachable and fits; else the first reachable one; else the first
   * configured one (which the availability guard then handles). Aliases with
   * no model are skipped.
   */
  choose(aliases: string[], ctx: Pick<Context, 'tokens' | 'images'>): Choice {
    const { tokens, images } = ctx;
    const chain = aliases.flatMap((a) => this.models(a) ?? []);
    const primary = chain[0];
    if (!primary) return { model: undefined, fits: false };
    const up = chain.filter((m) => m.available);
    const fitting = up.filter((m) => this.fits(m, tokens));
    const model =
      (images ? fitting.find((m) => m.vision) : undefined) ?? fitting[0] ?? up[0] ?? primary;
    const fits = this.fits(model, tokens);
    if (model === primary) return { model, fits };
    const detour = !primary.available
      ? { rule: 'fallback', reason: `${primary.alias} is unavailable; using ${model.alias}` }
      : !this.fits(primary, tokens)
        ? {
            rule: 'context-fit',
            reason: `~${tokens} tokens exceeds ${primary.alias}'s window; using ${model.alias} (${model.contextWindow})`,
          }
        : {
            rule: 'vision',
            reason: `${primary.alias} can't see images; using ${model.alias}`,
          };
    return { model, detour, fits };
  }
  fits(m: ModelInfo, tokens: number): boolean {
    return tokens <= m.contextWindow * this.config.escalation.contextHeadroom;
  }
  /** `choose` among the aliases of a step that the guards would allow. */
  chooseAllowed(ctx: Context, step: number, tier?: Tier): Choice {
    const aliases = (ctx.steps[step] ?? []).filter((a) => {
      const m = this.models(a);
      return m && (m.tier === 'local' || ctx.remoteOk) && (!tier || m.tier === tier);
    });
    return this.choose(aliases, ctx);
  }
  /**
   * The next step above `from` with an allowed model that's up and fits.
   * Steps that are down, too small, or remote when remote isn't allowed are skipped.
   */
  climb(ctx: Context, from: number, remoteOk = ctx.remoteOk): Rung | undefined {
    const scoped = { ...ctx, remoteOk };
    for (let step = from + 1; step < ctx.steps.length; step++) {
      const choice = this.chooseAllowed(scoped, step);
      if (choice.model?.available && choice.fits) return { choice, step };
    }
    return undefined;
  }
  /** The allowed, available model above `from` with the largest context window. */
  largestAbove(ctx: Context, from: number): Rung | undefined {
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
  rungAt(ctx: Context, step: number): Choice | undefined {
    const choice = this.chooseAllowed(ctx, step);
    return choice.model?.available ? choice : undefined;
  }
  /** The first model of a tier in role order: up and fitting, else up, else configured. */
  ofTier(ctx: Context, tier: Tier): Rung | undefined {
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
  nearestLocal(ctx: Context, from: number): Rung | undefined {
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
  /**
   * For an outage: the nearest other step with an allowed model that's up,
   * higher steps first, then lower. Remote models over budget don't count.
   */
  nearestUp(ctx: Context, from: number): Rung | undefined {
    const over = budgetReached(this.config.budget, ctx.input.spend) !== undefined;
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
}
