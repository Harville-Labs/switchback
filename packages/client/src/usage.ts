/**
 * Usage reports as text and the arithmetic behind the usage dashboard: which
 * days a period covers, daily totals for a chart, and block-character bars.
 * Days are UTC, as the ledger records them.
 */
import type { Usage, UsageRange, UsageReport, UsageRow } from '@switchback/protocol';
import { speedLabel } from './format.ts';

/** Dollars to the cent, with `<$0.01` for amounts too small to round to one. */
export function usd(n: number): string {
  return n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

/** `950`, `12k`, `3.4M`. */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Every token a call moved: input (cached or not) and output. */
export function totalTokens(u: Usage): number {
  return u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + u.outputTokens;
}

export const USAGE_SPANS = ['today', 'week', 'month', 'year', 'all'] as const;
/** A preset span, or `custom` for a range the user typed. */
export type UsageSpan = (typeof USAGE_SPANS)[number] | 'custom';

const DAY_MS = 86_400_000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return isoDay(dayMs(day) + n * DAY_MS);
}

/** Days from `from` to `to`, both included. */
export function daysIn(r: UsageRange): number {
  return Math.round((dayMs(r.to) - dayMs(r.from)) / DAY_MS) + 1;
}

/** Older than any ledger, so `all` needs no lookup of the first entry. */
const EPOCH = '2000-01-01';

/**
 * The days a span covers, `back` spans before the current one. `week` is the
 * 7 days ending today; `month` and `year` are calendar ones, cut off at today
 * while current. A custom range steps back by its own length.
 */
export function usageRange(
  span: UsageSpan,
  today: string,
  back = 0,
  custom?: UsageRange,
): UsageRange {
  switch (span) {
    case 'today': {
      const day = addDays(today, -back);
      return { from: day, to: day };
    }
    case 'week': {
      const to = addDays(today, -7 * back);
      return { from: addDays(to, -6), to };
    }
    case 'month': {
      const y = Number(today.slice(0, 4));
      const m = Number(today.slice(5, 7)) - 1 - back;
      // Day 0 of the next month is the last day of this one.
      const last = back === 0 ? today : isoDay(Date.UTC(y, m + 1, 0));
      return { from: isoDay(Date.UTC(y, m, 1)), to: last };
    }
    case 'year': {
      const y = Number(today.slice(0, 4)) - back;
      return { from: `${y}-01-01`, to: back === 0 ? today : `${y}-12-31` };
    }
    case 'all':
      return { from: EPOCH, to: today };
    case 'custom': {
      if (!custom) throw new Error('a custom usage span needs a range');
      const n = daysIn(custom) * back;
      return { from: addDays(custom.from, -n), to: addDays(custom.to, -n) };
    }
  }
}

const fmt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
const monthDay = fmt({ month: 'short', day: 'numeric' });
const monthDayYear = fmt({ month: 'short', day: 'numeric', year: 'numeric' });
const monthYear = fmt({ month: 'long', year: 'numeric' });

/** `Today`, `Yesterday`, `September 2026`, `2026`, `All time`, or `Sep 21 – Sep 27, 2026`. */
export function rangeLabel(span: UsageSpan, r: UsageRange, today: string): string {
  if (span === 'all') return 'All time';
  if (span === 'year') return r.from.slice(0, 4);
  if (span === 'month') return monthYear.format(dayMs(r.from));
  if (r.from === r.to) {
    if (r.to === today) return 'Today';
    if (r.to === addDays(today, -1)) return 'Yesterday';
    return monthDayYear.format(dayMs(r.to));
  }
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  return `${(sameYear ? monthDay : monthDayYear).format(dayMs(r.from))} – ${monthDayYear.format(dayMs(r.to))}`;
}

export const CHART_METRICS = ['cost', 'saved', 'tokens', 'calls'] as const;
export type ChartMetric = (typeof CHART_METRICS)[number];

/** One column of the usage chart: a day, or a month for long ranges. */
export interface UsageBucket {
  key: string;
  calls: number;
  costUsd: number;
  savingsUsd: number;
  tokens: number;
}

export function bucketValue(b: UsageBucket, metric: ChartMetric): number {
  switch (metric) {
    case 'cost':
      return b.costUsd;
    case 'saved':
      return b.savingsUsd;
    case 'tokens':
      return b.tokens;
    case 'calls':
      return b.calls;
  }
}

/**
 * The report's days spread over the range, empty days included, so the chart
 * shows quiet days as gaps. Ranges longer than `maxDays` go by month instead;
 * ranges over a year start at the first month with calls (`all` starts in 2000).
 */
export function usageBuckets(byDay: UsageRow[], r: UsageRange, maxDays = 62): UsageBucket[] {
  const byMonth = daysIn(r) > maxDays;
  const keyOf = (day: string) => (byMonth ? day.slice(0, 7) : day);
  const totals = new Map<string, UsageBucket>();
  for (const row of byDay) {
    const key = keyOf(row.key);
    const b = totals.get(key) ?? { key, calls: 0, costUsd: 0, savingsUsd: 0, tokens: 0 };
    b.calls += row.calls;
    b.costUsd += row.costUsd;
    b.savingsUsd += row.savingsUsd;
    b.tokens += totalTokens(row.usage);
    totals.set(key, b);
  }
  const empty = (key: string): UsageBucket => ({
    key,
    calls: 0,
    costUsd: 0,
    savingsUsd: 0,
    tokens: 0,
  });
  const keys: string[] = [];
  if (byMonth) {
    // A year shows all its months; anything longer starts where the calls do.
    const first = byDay[0]?.key ?? r.to;
    const start = daysIn(r) > 366 && first > r.from ? first : r.from;
    for (let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7)); ; m++) {
      if (m > 12) {
        y++;
        m = 1;
      }
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (key > r.to.slice(0, 7)) break;
      keys.push(key);
    }
  } else {
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) keys.push(d);
  }
  return keys.map((k) => totals.get(k) ?? empty(k));
}

const EIGHTHS = ' ▁▂▃▄▅▆▇█';

/**
 * A column chart `height` rows tall, one character per value, top row first.
 * Any value above zero shows at least a sliver, so a cheap day isn't lost.
 */
export function columnChart(values: number[], height: number): string[] {
  const max = Math.max(0, ...values);
  const eighths = values.map((v) =>
    v <= 0 || max === 0 ? 0 : Math.max(1, Math.round((v / max) * height * 8)),
  );
  return Array.from({ length: height }, (_, row) => {
    const floor = (height - 1 - row) * 8;
    return eighths.map((e) => EIGHTHS[Math.min(8, Math.max(0, e - floor))]).join('');
  });
}

const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** A horizontal bar `width` cells wide, filled to `fraction` (clamped to 0..1) in eighths. */
export function meter(fraction: number, width: number): { filled: string; empty: string } {
  const eighths = Math.round(Math.min(1, Math.max(0, fraction)) * width * 8);
  const full = Math.floor(eighths / 8);
  const part = PARTIAL[eighths % 8] ?? '';
  const filled = '█'.repeat(full) + part;
  return { filled, empty: '░'.repeat(width - full - (part ? 1 : 0)) };
}

export type UsageBreakdown = 'rule' | 'agent' | 'model';

/**
 * Plain-text usage summary shared by `switchback usage`, the TUI's `/usage`, and
 * VS Code. `by` adds a breakdown table.
 */
export function formatUsage(u: UsageReport, by?: UsageBreakdown): string {
  const $ = (n: number) => `$${n.toFixed(2)}`;
  const tok = (n: number) => n.toLocaleString('en-US');
  const { local, remote } = u.byTier;
  const lines = [
    `Usage ${u.period.from} to ${u.period.to}`,
    `  local   ${tok(local.usage.inputTokens)} in / ${tok(local.usage.outputTokens)} out   ${$(0)}`,
    `  remote  ${tok(remote.usage.inputTokens)} in / ${tok(remote.usage.outputTokens)} out   ${$(remote.costUsd)}${u.remoteCacheHitRate !== undefined ? `   cache hits ${Math.round(u.remoteCacheHitRate * 100)}%` : ''}`,
    `  saved   ~${$(u.estimatedSavingsUsd)} vs. running everything remotely`,
    `  budget  today ${$(u.budget.spentTodayUsd)}${u.budget.dailyUsd ? ` of ${$(u.budget.dailyUsd)}` : ''}, month ${$(u.budget.spentMonthUsd)}${u.budget.monthlyUsd ? ` of ${$(u.budget.monthlyUsd)}` : ''}`,
  ];
  const rows = by === 'rule' ? u.byRule : by === 'agent' ? u.byAgent : by ? u.byModel : undefined;
  if (by && rows) {
    lines.push('', `By ${by}`);
    const width = Math.max(by.length, ...rows.map((r) => r.key.length));
    for (const r of rows) {
      lines.push(
        `  ${r.key.padEnd(width)}  ${String(r.calls).padStart(5)} calls  ${tok(r.usage.inputTokens + (r.usage.cacheReadTokens ?? 0)).padStart(12)} in  ${$(r.costUsd).padStart(9)}${by === 'model' && r.tokensPerSecond !== undefined ? `  ${speedLabel(r.tokensPerSecond).padStart(11)}` : ''}`,
      );
    }
    if (rows.length === 0) lines.push('  no model calls in this period');
  }
  return lines.join('\n');
}

/**
 * The savings receipt: what a session (with its subagents) cost, against what
 * the same work would have cost on the reference remote model.
 */
export function formatReceipt(u: UsageReport, title = 'This session'): string {
  const $ = usd;
  const tok = compactTokens;
  const { local, remote } = u.byTier;
  const localTokens = local.usage.inputTokens + (local.usage.cacheReadTokens ?? 0);
  const remoteTokens = remote.usage.inputTokens + (remote.usage.cacheReadTokens ?? 0);
  const allRemote = remote.costUsd + u.estimatedSavingsUsd;
  const lines = [
    title,
    `  local    ${$(0).padStart(7)}   ${tok(localTokens)} tokens in, ${tok(local.usage.outputTokens)} out`,
    `  remote   ${$(remote.costUsd).padStart(7)}   ${tok(remoteTokens)} tokens in, ${tok(remote.usage.outputTokens)} out`,
  ];
  if (u.referenceModel && u.estimatedSavingsUsd > 0) {
    const pct = allRemote > 0 ? Math.round((u.estimatedSavingsUsd / allRemote) * 100) : 0;
    lines.push(
      `  all-remote on ${u.referenceModel} would have cost ~${$(allRemote)}`,
      `  saved    ~${$(u.estimatedSavingsUsd)} (${pct}%)`,
    );
  } else if (!u.referenceModel && localTokens > 0) {
    lines.push('  (configure a remote model to see what running locally saved)');
  }
  return lines.join('\n');
}

/** One line for the end of a headless run: `cost $0.04 · saved ~$0.61 (94%) vs. claude-opus-5`. */
export function receiptLine(u: UsageReport): string {
  const cost = u.byTier.remote.costUsd;
  const allRemote = cost + u.estimatedSavingsUsd;
  const saved =
    u.referenceModel && u.estimatedSavingsUsd > 0
      ? ` · saved ~$${u.estimatedSavingsUsd.toFixed(2)} (${Math.round((u.estimatedSavingsUsd / allRemote) * 100)}%) vs. all-remote on ${u.referenceModel}`
      : '';
  return `cost $${cost.toFixed(4)}${saved}`;
}

const monthShortYear = fmt({ month: 'short', year: 'numeric' });

/** A chart bucket's axis label: `Oct 14` for a day, `Nov 2025` for a month. */
export function bucketLabel(key: string): string {
  return key.length === 7 ? monthShortYear.format(dayMs(`${key}-01`)) : monthDay.format(dayMs(key));
}
