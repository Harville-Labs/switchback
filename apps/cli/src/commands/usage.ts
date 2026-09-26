/** `harness usage`: this month's spend by tier and estimated savings. */
import { type CommonFlags, createEngine } from '../bootstrap.ts';

export async function usage(flags: CommonFlags & { json: boolean }): Promise<number> {
  const report = createEngine(flags, 'deny').engine.usage();
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const tok = (n: number) => n.toLocaleString('en-US');
  const { local, remote } = report.byTier;
  process.stdout.write(
    [
      `Usage ${report.period.from} to ${report.period.to}`,
      `  local   ${tok(local.usage.inputTokens)} in / ${tok(local.usage.outputTokens)} out   ${fmt(0)}`,
      `  remote  ${tok(remote.usage.inputTokens)} in / ${tok(remote.usage.outputTokens)} out   ${fmt(remote.costUsd)}`,
      `  saved   ~${fmt(report.estimatedSavingsUsd)} vs. running everything remotely`,
      `  budget  today ${fmt(report.budget.spentTodayUsd)}${report.budget.dailyUsd ? ` of ${fmt(report.budget.dailyUsd)}` : ''}, month ${fmt(report.budget.spentMonthUsd)}${report.budget.monthlyUsd ? ` of ${fmt(report.budget.monthlyUsd)}` : ''}`,
      '',
    ].join('\n'),
  );
  return 0;
}
