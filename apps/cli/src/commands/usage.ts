/**
 * `switchback usage`: spend by tier, savings, cache hits, and optional
 * breakdowns. In a terminal it's an interactive dashboard; piped, it prints
 * the plain report.
 */
import { formatUsage, USAGE_SPANS, type UsageBreakdown, usageRange } from '@switchback/client';
import { UsageRange } from '@switchback/protocol';
import { type CommonFlags, createEngine } from '../bootstrap.ts';

const BREAKDOWNS = ['rule', 'agent', 'model'] as const;

export async function usage(
  flags: CommonFlags & {
    json: boolean;
    by?: string;
    period?: string;
    from?: string;
    to?: string;
  },
): Promise<number> {
  const fail = (message: string) => {
    process.stderr.write(`switchback: ${message}\n`);
    return 2;
  };
  const span = flags.period ?? 'month';
  if (!USAGE_SPANS.includes(span as (typeof USAGE_SPANS)[number]))
    return fail(`--period must be one of ${USAGE_SPANS.join(', ')}`);
  if (flags.by && !BREAKDOWNS.includes(flags.by as UsageBreakdown))
    return fail(`--by must be one of ${BREAKDOWNS.join(', ')}`);
  if (flags.to && !flags.from) return fail('--to needs --from (both are YYYY-MM-DD, UTC)');
  if (flags.from && flags.period) return fail('use --period or --from/--to, not both');

  // UTC, like the ledger's timestamps.
  const today = new Date().toISOString().slice(0, 10);
  let custom: UsageRange | undefined;
  if (flags.from) {
    const parsed = UsageRange.safeParse({ from: flags.from, to: flags.to ?? today });
    if (!parsed.success)
      return fail(
        `--from/--to must be dates as YYYY-MM-DD with --from first (${parsed.error.issues[0]?.message})`,
      );
    custom = parsed.data;
  }
  const engine = createEngine(flags, 'deny').engine;
  const range = custom ?? usageRange(span as (typeof USAGE_SPANS)[number], today);

  if (!flags.json && process.stdin.isTTY && process.stdout.isTTY) {
    const { runUsageDashboard } = await import('../tui/UsageDashboard.tsx');
    await runUsageDashboard({
      load: (r) => engine.usage(r),
      today,
      initialSpan: custom ? 'custom' : (span as (typeof USAGE_SPANS)[number]),
      initialBy: (flags.by as UsageBreakdown | undefined) ?? 'rule',
      ...(custom ? { custom } : {}),
    });
    return 0;
  }
  const report = engine.usage(range);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${formatUsage(report, flags.by as UsageBreakdown | undefined)}\n`);
  return 0;
}
