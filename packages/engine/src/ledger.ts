/**
 * Append-only usage ledger. Every model call is recorded with its cost and,
 * for local calls, what the same tokens would have cost on the reference
 * remote model. That "saved" number is the product's headline metric.
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
} from '@harness/protocol';
import { costUsd, type Price, priceFor } from '@harness/providers';

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

export class UsageLedger {
  private entries: LedgerEntry[] = [];

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
    meta: { rule?: string; agent?: string } = {},
  ): LedgerEntry {
    const cost = tier === 'local' ? 0 : costUsd(usage, priceFor(model.model, this.prices));
    const reference = this.referenceModel ? priceFor(this.referenceModel, this.prices) : undefined;
    const savings = tier === 'local' ? costUsd(usage, reference) : 0;
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

  sessionCost(sessionId: string): { usage: Usage; costUsd: number } {
    let usage = emptyUsage();
    let cost = 0;
    for (const e of this.entries) {
      if (e.sessionId !== sessionId) continue;
      usage = addUsage(usage, e.usage);
      cost += e.costUsd;
    }
    return { usage, costUsd: cost };
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

  report(
    budget: { dailyUsd?: number; monthlyUsd?: number },
    period: UsagePeriod = 'month',
  ): UsageReport {
    const now = this.now();
    const today = now.toISOString().slice(0, 10);
    const from =
      period === 'today'
        ? today
        : period === 'week'
          ? new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10)
          : `${today.slice(0, 7)}-01`;
    const entries = this.entries.filter((e) => e.ts >= from);
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
