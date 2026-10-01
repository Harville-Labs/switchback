/**
 * Append-only usage ledger. Every model call is recorded with its cost and,
 * for local calls, what the same tokens would have cost on the reference
 * remote model. That "saved" number is the product's headline metric, so it
 * is estimated conservatively: an all-remote session would have read most of
 * each prompt from the provider's cache, so it's priced that way.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  addUsage,
  emptyUsage,
  type ModelRef,
  type Tier,
  type Usage,
  type UsagePeriod,
  type UsageReport,
  type UsageRow,
} from '@switchback/protocol';
import { costUsd, type Price, priceFor } from '@switchback/providers';

export interface LedgerEntry {
  ts: string;
  sessionId: string;
  tier: Tier;
  model: ModelRef;
  usage: Usage;
  costUsd: number;
  savingsUsd: number;
  /** Routing rule that picked the model (absent in ledgers written before 0.4). */
  rule?: string;
  agent?: string;
}

/** Group entries by a key, most expensive first (ties: most calls). */
export function groupUsage(entries: LedgerEntry[], key: (e: LedgerEntry) => string): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const e of entries) {
    const k = key(e);
    const row = rows.get(k) ?? { key: k, calls: 0, usage: emptyUsage(), costUsd: 0, savingsUsd: 0 };
    row.calls++;
    row.usage = addUsage(row.usage, e.usage);
    row.costUsd += e.costUsd;
    row.savingsUsd += e.savingsUsd;
    rows.set(k, row);
  }
  return [...rows.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

/** Share of input tokens read from cache. Input counts exclude cached tokens for every adapter. */
export function cacheHitRate(usage: Usage): number | undefined {
  const read = usage.cacheReadTokens ?? 0;
  const total = usage.inputTokens + read + (usage.cacheWriteTokens ?? 0);
  return total > 0 ? read / total : undefined;
}

/** Prompt caches last at least this long between calls (Anthropic's default TTL). */
const CACHE_TTL_MS = 5 * 60_000;

/**
 * What a local call would have cost on the reference model. The part of the
 * prompt already sent by the session's previous call (within the cache
 * lifetime) is priced as a cache read, the rest at the input price.
 */
export function counterfactualCost(
  usage: Usage,
  price: Price | undefined,
  previousPromptTokens: number,
): number {
  const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const cached = Math.min(previousPromptTokens, prompt);
  return costUsd(
    {
      inputTokens: prompt - cached,
      outputTokens: usage.outputTokens,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
    price,
  );
}

export class UsageLedger {
  private entries: LedgerEntry[] = [];
  /** Each session's last prompt size and time, for counterfactual cache pricing. */
  private lastPrompt = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly file: string | undefined,
    private prices: Record<string, Price>,
    /** Model whose prices define "what this would have cost remotely". */
    private referenceModel: string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.entries.push(JSON.parse(line));
        } catch {
          // A torn final line from a crash is not worth failing startup over.
        }
      }
    }
  }

  record(
    sessionId: string,
    tier: Tier,
    model: ModelRef,
    usage: Usage,
    meta: { rule?: string; agent?: string; costUsd?: number } = {},
  ): LedgerEntry {
    // A runtime that reports its own cost (external agents) is taken at its word.
    const cost =
      tier === 'local' ? 0 : (meta.costUsd ?? costUsd(usage, priceFor(model.model, this.prices)));
    const reference = this.referenceModel ? priceFor(this.referenceModel, this.prices) : undefined;
    const at = this.now().getTime();
    const prev = this.lastPrompt.get(sessionId);
    const warm = prev && at - prev.at <= CACHE_TTL_MS ? prev.tokens : 0;
    const savings = tier === 'local' ? counterfactualCost(usage, reference, warm) : 0;
    this.lastPrompt.set(sessionId, {
      tokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      at,
    });
    const entry: LedgerEntry = {
      ts: this.now().toISOString(),
      sessionId,
      tier,
      model,
      usage,
      costUsd: cost,
      savingsUsd: savings,
      ...(meta.rule ? { rule: meta.rule } : {}),
      ...(meta.agent ? { agent: meta.agent } : {}),
    };
    this.entries.push(entry);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    }
    return entry;
  }

  setPricing(prices: Record<string, Price>, referenceModel: string | undefined): void {
    this.prices = prices;
    this.referenceModel = referenceModel;
  }

  priceOf(model: string): Price | undefined {
    return priceFor(model, this.prices);
  }

  entriesSince(sinceIso: string): LedgerEntry[] {
    return this.entries.filter((e) => e.ts > sinceIso);
  }

  spend(): { todayUsd: number; monthUsd: number } {
    const now = this.now();
    const day = now.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    let todayUsd = 0;
    let monthUsd = 0;
    for (const e of this.entries) {
      if (e.ts.startsWith(month)) monthUsd += e.costUsd;
      if (e.ts.startsWith(day)) todayUsd += e.costUsd;
    }
    return { todayUsd, monthUsd };
  }

  sessionCost(sessionId: string): { usage: Usage; costUsd: number; savingsUsd: number } {
    let usage = emptyUsage();
    let cost = 0;
    let savings = 0;
    for (const e of this.entries) {
      if (e.sessionId !== sessionId) continue;
      usage = addUsage(usage, e.usage);
      cost += e.costUsd;
      savings += e.savingsUsd;
    }
    return { usage, costUsd: cost, savingsUsd: savings };
  }

  /** Mean output tokens per call in a session, for cost estimates. */
  meanOutputTokens(sessionId: string): number | undefined {
    let calls = 0;
    let out = 0;
    for (const e of this.entries) {
      if (e.sessionId !== sessionId) continue;
      calls++;
      out += e.usage.outputTokens;
    }
    return calls ? out / calls : undefined;
  }

  /**
   * Usage for a period, or for a set of sessions (a session and its
   * subagents) over their whole life.
   */
  report(
    budget: { dailyUsd?: number; monthlyUsd?: number },
    period: UsagePeriod = 'month',
    sessions?: Set<string>,
  ): UsageReport {
    const now = this.now();
    const today = now.toISOString().slice(0, 10);
    let from =
      period === 'today'
        ? today
        : period === 'week'
          ? new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10)
          : `${today.slice(0, 7)}-01`;
    const entries = sessions
      ? this.entries.filter((e) => sessions.has(e.sessionId))
      : this.entries.filter((e) => e.ts >= from);
    if (sessions) from = entries[0]?.ts.slice(0, 10) ?? today;
    const byTier: UsageReport['byTier'] = {
      local: { usage: emptyUsage(), costUsd: 0 },
      remote: { usage: emptyUsage(), costUsd: 0 },
    };
    let savings = 0;
    for (const e of entries) {
      byTier[e.tier].usage = addUsage(byTier[e.tier].usage, e.usage);
      byTier[e.tier].costUsd += e.costUsd;
      savings += e.savingsUsd;
    }
    const spend = this.spend();
    const hitRate = cacheHitRate(byTier.remote.usage);
    return {
      period: { from, to: today },
      byTier,
      estimatedSavingsUsd: savings,
      ...(this.referenceModel ? { referenceModel: this.referenceModel } : {}),
      budget: {
        ...(budget.dailyUsd !== undefined ? { dailyUsd: budget.dailyUsd } : {}),
        ...(budget.monthlyUsd !== undefined ? { monthlyUsd: budget.monthlyUsd } : {}),
        spentTodayUsd: spend.todayUsd,
        spentMonthUsd: spend.monthUsd,
      },
      byRule: groupUsage(entries, (e) => e.rule ?? 'unrecorded'),
      byAgent: groupUsage(entries, (e) => e.agent ?? 'unrecorded'),
      byModel: groupUsage(entries, (e) => `${e.model.provider}/${e.model.model}`),
      ...(hitRate !== undefined ? { remoteCacheHitRate: hitRate } : {}),
    };
  }
}
