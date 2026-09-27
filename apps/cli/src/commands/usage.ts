/** `harness usage`: spend by tier, savings, cache hits, and optional breakdowns. */
import { formatUsage, type UsageBreakdown } from '@harness/client';
import type { UsagePeriod } from '@harness/protocol';
import { type CommonFlags, createEngine } from '../bootstrap.ts';

const PERIODS = ['today', 'week', 'month'] as const;
const BREAKDOWNS = ['rule', 'agent', 'model'] as const;

export async function usage(
  flags: CommonFlags & { json: boolean; by?: string; period?: string },
): Promise<number> {
  if (flags.period && !PERIODS.includes(flags.period as UsagePeriod)) {
    process.stderr.write(`harness: --period must be one of ${PERIODS.join(', ')}\n`);
    return 2;
  }
  if (flags.by && !BREAKDOWNS.includes(flags.by as UsageBreakdown)) {
    process.stderr.write(`harness: --by must be one of ${BREAKDOWNS.join(', ')}\n`);
    return 2;
  }
  const report = createEngine(flags, 'deny').engine.usage(flags.period as UsagePeriod | undefined);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${formatUsage(report, flags.by as UsageBreakdown | undefined)}\n`);
  return 0;
}
