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
  type UsageReport,
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

  record(sessionId: string, tier: Tier, model: ModelRef, usage: Usage): LedgerEntry {
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

  report(budget: { dailyUsd?: number; monthlyUsd?: number }): UsageReport {
    const now = this.now();
    const month = now.toISOString().slice(0, 7);
    const byTier: UsageReport['byTier'] = {
      local: { usage: emptyUsage(), costUsd: 0 },
      remote: { usage: emptyUsage(), costUsd: 0 },
    };
    let savings = 0;
    for (const e of this.entries) {
      if (!e.ts.startsWith(month)) continue;
      byTier[e.tier].usage = addUsage(byTier[e.tier].usage, e.usage);
      byTier[e.tier].costUsd += e.costUsd;
      savings += e.savingsUsd;
    }
    const spend = this.spend();
    return {
      period: { from: `${month}-01`, to: now.toISOString().slice(0, 10) },
      byTier,
      estimatedSavingsUsd: savings,
      budget: {
        ...(budget.dailyUsd !== undefined ? { dailyUsd: budget.dailyUsd } : {}),
        ...(budget.monthlyUsd !== undefined ? { monthlyUsd: budget.monthlyUsd } : {}),
        spentTodayUsd: spend.todayUsd,
        spentMonthUsd: spend.monthUsd,
      },
    };
  }
}
