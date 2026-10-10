/** Usage and telemetry: daily reports from clients, and the console's views of them. */
import { DailyReport } from '@harville-labs/switchback-org/telemetry';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as t from '../schema.ts';
import type { Ctx, Site, User } from './core.ts';

const UsageEntry = z.object({
  date: z.iso.date(),
  tier: z.enum(['local', 'remote']),
  provider: z.string().max(200),
  model: z.string().max(200),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative(),
});

/** Add a member's usage. Clients report increments, so rows accumulate. */
export async function addUsage(
  ctx: Ctx,
  site: Site,
  user: User,
  entries: unknown,
): Promise<number> {
  const parsed = z.array(UsageEntry).max(10_000).parse(entries);
  if (!parsed.length) return 0;
  const u = t.usageDaily;
  await ctx.db
    .insert(u)
    .values(parsed.map((e) => ({ siteId: site.id, userId: user.id, ...e })))
    .onConflictDoUpdate({
      target: [u.siteId, u.userId, u.date, u.tier, u.provider, u.model],
      set: {
        calls: sql`${u.calls} + excluded.calls`,
        inputTokens: sql`${u.inputTokens} + excluded.input_tokens`,
        outputTokens: sql`${u.outputTokens} + excluded.output_tokens`,
        cacheReadTokens: sql`${u.cacheReadTokens} + excluded.cache_read_tokens`,
        costUsd: sql`${u.costUsd} + excluded.cost_usd`,
      },
    });
  return parsed.length;
}

export interface UsageSummary {
  from: string;
  totals: { local: number; remote: number; costUsd: number };
  byMember: { email: string; calls: number; localCalls: number; costUsd: number }[];
  byModel: { tier: string; model: string; calls: number; costUsd: number }[];
}

export async function usageSummary(
  ctx: Ctx,
  site: Site,
  days = 30,
  onlyFor?: User,
): Promise<UsageSummary> {
  const from = new Date(ctx.now().getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await ctx.db
    .select({
      email: t.user.email,
      tier: t.usageDaily.tier,
      model: t.usageDaily.model,
      calls: t.usageDaily.calls,
      costUsd: t.usageDaily.costUsd,
    })
    .from(t.usageDaily)
    .innerJoin(t.user, eq(t.user.id, t.usageDaily.userId))
    .where(
      and(
        eq(t.usageDaily.siteId, site.id),
        gte(t.usageDaily.date, from),
        onlyFor ? eq(t.usageDaily.userId, onlyFor.id) : undefined,
      ),
    );
  const totals = { local: 0, remote: 0, costUsd: 0 };
  const members = new Map<string, UsageSummary['byMember'][number]>();
  const models = new Map<string, UsageSummary['byModel'][number]>();
  for (const r of rows) {
    const local = r.tier === 'local';
    totals[r.tier] += r.calls;
    totals.costUsd += r.costUsd;
    const m = members.get(r.email) ?? { email: r.email, calls: 0, localCalls: 0, costUsd: 0 };
    m.calls += r.calls;
    if (local) m.localCalls += r.calls;
    m.costUsd += r.costUsd;
    members.set(r.email, m);
    const key = `${r.tier}\u0000${r.model}`;
    const mo = models.get(key) ?? { tier: r.tier, model: r.model, calls: 0, costUsd: 0 };
    mo.calls += r.calls;
    mo.costUsd += r.costUsd;
    models.set(key, mo);
  }
  const byCost = <T extends { costUsd: number; calls: number }>(a: T, b: T) =>
    b.costUsd - a.costUsd || b.calls - a.calls;
  return {
    from,
    totals,
    byMember: [...members.values()].sort(byCost),
    byModel: [...models.values()].sort(byCost),
  };
}

/** Store telemetry reports (schema-checked); a resent day replaces the earlier copy. */
export async function storeTelemetry(
  ctx: Ctx,
  site: Site | undefined,
  body: unknown,
): Promise<number> {
  const { reports } = z.object({ reports: z.array(DailyReport).max(60) }).parse(body);
  if (!reports.length) return 0;
  const tr = t.telemetryReports;
  await ctx.db
    .insert(tr)
    .values(
      reports.map((r) => ({
        installId: r.installId,
        day: r.day,
        siteId: site?.id ?? null,
        report: r,
        receivedAt: ctx.now(),
      })),
    )
    .onConflictDoUpdate({
      target: [tr.installId, tr.day],
      set: {
        siteId: sql`excluded.site_id`,
        report: sql`excluded.report`,
        receivedAt: sql`excluded.received_at`,
      },
    });
  return reports.length;
}

export interface TelemetrySummary {
  installs: number;
  calls: { local: number; remote: number };
  costUsd: number;
  savingsUsd: number;
  bySite: { site: string; installs: number; calls: number; costUsd: number; savingsUsd: number }[];
  byRule: { rule: string; local: number; remote: number; costUsd: number }[];
  versions: { version: string; installs: number }[];
  crashes: { day: string; site: string; name: string; message: string; stack: string }[];
}

/** Switchback manager view: telemetry across every site (and unaffiliated installs) for recent days. */
export async function telemetrySummary(ctx: Ctx, days = 30): Promise<TelemetrySummary> {
  const from = new Date(ctx.now().getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await ctx.db
    .select({ report: t.telemetryReports.report, slug: t.organization.slug })
    .from(t.telemetryReports)
    .leftJoin(t.organization, eq(t.organization.id, t.telemetryReports.siteId))
    .where(gte(t.telemetryReports.day, from))
    .orderBy(t.telemetryReports.day);
  const out: TelemetrySummary = {
    installs: 0,
    calls: { local: 0, remote: 0 },
    costUsd: 0,
    savingsUsd: 0,
    bySite: [],
    byRule: [],
    versions: [],
    crashes: [],
  };
  const installs = new Set<string>();
  const sites = new Map<string, TelemetrySummary['bySite'][number] & { ids: Set<string> }>();
  const rules = new Map<string, TelemetrySummary['byRule'][number]>();
  const versions = new Map<string, Set<string>>();
  for (const row of rows) {
    const r = row.report as DailyReport;
    const site = row.slug ?? '(no site)';
    installs.add(r.installId);
    out.calls.local += r.calls.local;
    out.calls.remote += r.calls.remote;
    out.costUsd += r.costUsd;
    out.savingsUsd += r.savingsUsd;
    const s = sites.get(site) ?? {
      site,
      installs: 0,
      calls: 0,
      costUsd: 0,
      savingsUsd: 0,
      ids: new Set<string>(),
    };
    s.ids.add(r.installId);
    s.calls += r.calls.local + r.calls.remote;
    s.costUsd += r.costUsd;
    s.savingsUsd += r.savingsUsd;
    sites.set(site, s);
    for (const [rule, v] of Object.entries(r.byRule)) {
      const x = rules.get(rule) ?? { rule, local: 0, remote: 0, costUsd: 0 };
      x.local += v.local;
      x.remote += v.remote;
      x.costUsd += v.costUsd;
      rules.set(rule, x);
    }
    const v = versions.get(r.version) ?? new Set<string>();
    v.add(r.installId);
    versions.set(r.version, v);
    for (const c of r.crashes) out.crashes.push({ day: r.day, site, ...c });
  }
  out.installs = installs.size;
  out.bySite = [...sites.values()]
    .map(({ ids, ...s }) => ({ ...s, installs: ids.size }))
    .sort((a, b) => b.calls - a.calls);
  out.byRule = [...rules.values()].sort((a, b) => b.local + b.remote - (a.local + a.remote));
  out.versions = [...versions].map(([version, ids]) => ({ version, installs: ids.size }));
  out.crashes = out.crashes.slice(-50).reverse();
  return out;
}
