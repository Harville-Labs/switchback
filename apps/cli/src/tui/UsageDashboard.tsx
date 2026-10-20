/**
 * `switchback usage` in a terminal: spend, savings, and budget for a period
 * the user picks, a chart of each day (or month), and the breakdown by rule,
 * agent, or model. Every number comes from one `UsageReport`; the arithmetic
 * lives in `@switchback/client` so other clients can draw the same thing.
 */
import {
  bucketLabel,
  bucketValue,
  CHART_METRICS,
  type ChartMetric,
  columnChart,
  compactTokens,
  meter,
  rangeLabel,
  speedLabel,
  totalTokens,
  USAGE_SPANS,
  type UsageBreakdown,
  type UsageSpan,
  usageBuckets,
  usageRange,
  usd,
} from '@switchback/client';
import type { UsageRange, UsageReport, UsageRow } from '@switchback/protocol';
import { Box, render, Text, useInput, useWindowSize } from 'ink';
import { useMemo, useState } from 'react';
import { savedTheme, THEMES, ThemeContext, useTheme } from './theme.ts';

const BREAKDOWNS: UsageBreakdown[] = ['rule', 'agent', 'model'];
const SPAN_LABELS: Record<UsageSpan, string> = {
  today: 'Today',
  week: '7 days',
  month: 'Month',
  year: 'Year',
  all: 'All time',
  custom: 'Custom',
};
const METRIC_TITLES: Record<ChartMetric, string> = {
  cost: 'Remote spend',
  saved: 'Saved by running locally',
  tokens: 'Tokens',
  calls: 'Model calls',
};
const CHART_HEIGHT = 6;
const ROWS = 8;
/** Wider than this and the columns of numbers drift too far apart to read. */
const MAX_WIDTH = 96;

const cycle = <T,>(list: readonly T[], current: T, step: number): T =>
  list[(list.indexOf(current) + step + list.length) % list.length] as T;

const metricText = (metric: ChartMetric, n: number) =>
  metric === 'cost' || metric === 'saved'
    ? usd(n)
    : metric === 'tokens'
      ? compactTokens(n)
      : String(n);

type DashboardProps = Parameters<typeof UsageDashboard>[0];

/**
 * Draw the dashboard until the user quits. It stays inline rather than full
 * screen, so the last view is left in the scrollback.
 */
export async function runUsageDashboard(props: Omit<DashboardProps, 'onExit'>): Promise<void> {
  const app = render(
    <ThemeContext.Provider value={THEMES[savedTheme()]}>
      <UsageDashboard {...props} onExit={() => app.unmount()} />
    </ThemeContext.Provider>,
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
}

export function UsageDashboard({
  load,
  today,
  initialSpan = 'week',
  initialBy = 'rule',
  custom,
  onExit,
}: {
  load: (range: UsageRange) => UsageReport;
  /** UTC date the ranges count back from. */
  today: string;
  initialSpan?: UsageSpan;
  initialBy?: UsageBreakdown;
  /** The range from `--from`/`--to`, offered as the Custom span. */
  custom?: UsageRange;
  onExit: () => void;
}) {
  const t = useTheme();
  const { columns } = useWindowSize();
  const width = Math.min(MAX_WIDTH, Math.max(50, (columns || 80) - 2));
  const spans: UsageSpan[] = custom ? [...USAGE_SPANS, 'custom'] : [...USAGE_SPANS];
  const [span, setSpan] = useState<UsageSpan>(initialSpan);
  const [back, setBack] = useState(0);
  const [by, setBy] = useState<UsageBreakdown>(initialBy);
  const [metric, setMetric] = useState<ChartMetric>('cost');
  const [scroll, setScroll] = useState(0);

  const range = usageRange(span, today, back, custom);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the range's ends are its identity.
  const report = useMemo(() => load(range), [load, range.from, range.to]);
  const rows =
    (by === 'rule' ? report.byRule : by === 'agent' ? report.byAgent : report.byModel) ?? [];

  const choose = (next: UsageSpan) => {
    setSpan(next);
    setBack(0);
    setScroll(0);
  };
  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 'c')) return onExit();
    if (key.tab) return choose(cycle(spans, span, key.shift ? -1 : 1));
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= spans.length)
      return choose(spans[n - 1] as UsageSpan);
    if ((key.leftArrow || input === 'h') && span !== 'all') {
      setBack((b) => b + 1);
      return setScroll(0);
    }
    if (key.rightArrow || input === 'l') {
      // Keys can arrive faster than renders, so clamp in the update, not on `back`.
      setBack((b) => Math.max(0, b - 1));
      return setScroll(0);
    }
    if (input === 'b') {
      setBy((b) => cycle(BREAKDOWNS, b, 1));
      return setScroll(0);
    }
    if (input === 'm') return setMetric((m) => cycle(CHART_METRICS, m, 1));
    if (key.upArrow || input === 'k') return setScroll((s) => Math.max(0, s - 1));
    if (key.downArrow || input === 'j')
      return setScroll((s) => Math.min(Math.max(0, rows.length - ROWS), s + 1));
  });

  const inner = width - 4;
  const calls = (report.byDay ?? []).reduce((sum, d) => sum + d.calls, 0);
  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor={t.brand} paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color={t.brand}>
            ◆ Switchback usage
          </Text>
          <Text>
            <Text color={span === 'all' ? undefined : t.accent} dimColor={span === 'all'}>
              ‹{' '}
            </Text>
            <Text bold>{rangeLabel(span, range, today)}</Text>
            <Text color={back > 0 ? t.accent : undefined} dimColor={back === 0}>
              {' '}
              ›
            </Text>
          </Text>
        </Box>
        <Box gap={1} marginBottom={1}>
          {spans.map((s, i) => (
            <Text key={s} inverse={s === span} color={s === span ? t.accent : undefined}>
              {` ${i + 1} ${SPAN_LABELS[s]} `}
            </Text>
          ))}
        </Box>
        <Summary report={report} calls={calls} width={inner} />
        <Budget report={report} width={inner} />
        {calls === 0 ? (
          <Box marginY={1}>
            <Text dimColor>No model calls in this period. Press ← to look further back.</Text>
          </Box>
        ) : (
          <>
            <Chart report={report} range={range} metric={metric} width={inner} />
            <Breakdown rows={rows} by={by} scroll={scroll} width={inner} />
          </>
        )}
      </Box>
      <Text dimColor>
        {' '}
        <Text color={t.accent}>1-{spans.length}</Text> period · <Text color={t.accent}>←→</Text>{' '}
        earlier/later · <Text color={t.accent}>m</Text> chart · <Text color={t.accent}>b</Text>{' '}
        breakdown{rows.length > ROWS ? ' · ↑↓ scroll' : ''} · <Text color={t.accent}>q</Text> quit
      </Text>
    </Box>
  );
}

/** Spend and savings, and how the work split between local and remote models. */
function Summary({ report, calls, width }: { report: UsageReport; calls: number; width: number }) {
  const t = useTheme();
  const { local, remote } = report.byTier;
  const saved = report.estimatedSavingsUsd;
  const allRemote = remote.costUsd + saved;
  const localTokens = totalTokens(local.usage);
  const remoteTokens = totalTokens(remote.usage);
  const share = localTokens + remoteTokens ? localTokens / (localTokens + remoteTokens) : 0;
  const bar = meter(share, Math.max(10, width - 34));
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>Spent </Text>
        <Text bold color={t.remote}>
          {usd(remote.costUsd)}
        </Text>
        <Text dimColor>{'   '}Saved </Text>
        <Text bold color={t.local}>
          ~{usd(saved)}
        </Text>
        {report.referenceModel && allRemote > 0 ? (
          <Text dimColor>
            {' '}
            ({Math.round((saved / allRemote) * 100)}% vs. all-remote on {report.referenceModel})
          </Text>
        ) : null}
      </Text>
      <Text>
        <Text dimColor>Calls </Text>
        {calls.toLocaleString('en-US')}
        {report.remoteCacheHitRate !== undefined ? (
          <>
            <Text dimColor>{'   '}Remote cache hits </Text>
            {Math.round(report.remoteCacheHitRate * 100)}%
          </>
        ) : null}
      </Text>
      <Text>
        <Text color={t.local}>local {compactTokens(localTokens).padStart(6)} </Text>
        <Text color={t.local}>{bar.filled}</Text>
        <Text color={t.remote}>{bar.empty.replaceAll('░', '▒')}</Text>
        <Text color={t.remote}> {compactTokens(remoteTokens).padEnd(6)} remote</Text>
        <Text dimColor> tokens</Text>
      </Text>
    </Box>
  );
}

/** Today's and this month's spend against the budget, whatever period is shown. */
function Budget({ report, width }: { report: UsageReport; width: number }) {
  const b = report.budget;
  const lines: [string, number, number | undefined][] = [
    ['today', b.spentTodayUsd, b.dailyUsd],
    ['month', b.spentMonthUsd, b.monthlyUsd],
  ];
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map(([label, spent, limit]) => (
        <BudgetLine
          key={label}
          label={label}
          spent={spent}
          limit={limit}
          width={Math.max(10, width - 40)}
        />
      ))}
    </Box>
  );
}

function BudgetLine(props: { label: string; spent: number; limit?: number; width: number }) {
  const t = useTheme();
  const { label, spent, limit, width } = props;
  const head = <Text dimColor>{label === 'today' ? 'Budget today ' : '       month '}</Text>;
  if (!limit)
    return (
      <Text>
        {head}
        {usd(spent).padEnd(8)}
        <Text dimColor> no limit set</Text>
      </Text>
    );
  const used = spent / limit;
  const bar = meter(used, width);
  const color = used >= 1 ? t.error : used >= 0.8 ? t.warning : t.success;
  return (
    <Text>
      {head}
      {usd(spent).padEnd(8)}
      <Text dimColor>of {usd(limit).padEnd(8)}</Text>
      <Text color={color}>{bar.filled}</Text>
      <Text dimColor>{bar.empty}</Text>
      <Text color={color}> {Math.round(used * 100)}%</Text>
    </Text>
  );
}

function Chart(props: {
  report: UsageReport;
  range: UsageRange;
  metric: ChartMetric;
  width: number;
}) {
  const t = useTheme();
  const { report, range, metric, width } = props;
  // The newest buckets win when there are more than columns to draw them in.
  const buckets = usageBuckets(report.byDay ?? [], range).slice(-width);
  const values = buckets.map((b) => bucketValue(b, metric));
  const first = buckets[0];
  const last = buckets.at(-1);
  const per = first && first.key.length === 7 ? 'month' : 'day';
  // Gaps between columns when there's room; months are few, so they get wider ones.
  const widest = per === 'month' ? 5 : 3;
  const col = Math.max(1, Math.min(widest, Math.floor(width / Math.max(1, buckets.length))));
  const widen = (row: string) =>
    col === 1 ? row : [...row].map((c) => c.repeat(col - 1).padEnd(col)).join('');
  const color = metric === 'cost' ? t.remote : metric === 'saved' ? t.local : t.accent;
  const total = values.reduce((a, b) => a + b, 0);
  const drawn = buckets.length * col;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between" width={width}>
        <Text bold>
          {METRIC_TITLES[metric]} <Text dimColor>per {per}</Text>
        </Text>
        <Text dimColor>
          total {metricText(metric, total)} · peak {metricText(metric, Math.max(0, ...values))}
        </Text>
      </Box>
      {columnChart(values, CHART_HEIGHT).map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positions, top to bottom.
        <Text key={i} color={color}>
          {widen(row)}
        </Text>
      ))}
      {first && last ? (
        <Box justifyContent="space-between" width={Math.max(drawn, 20)}>
          <Text dimColor>{bucketLabel(first.key)}</Text>
          {last !== first ? <Text dimColor>{bucketLabel(last.key)}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}

function Breakdown(props: { rows: UsageRow[]; by: UsageBreakdown; scroll: number; width: number }) {
  const t = useTheme();
  const { rows, by, scroll, width } = props;
  const shown = rows.slice(scroll, scroll + ROWS);
  const keyWidth = Math.min(28, Math.max(8, ...rows.map((r) => r.key.length)));
  // Bars compare cost; when nothing cost anything, they compare calls.
  const paid = rows.some((r) => r.costUsd > 0);
  const size = (r: UsageRow) => (paid ? r.costUsd : r.calls);
  const max = Math.max(0, ...rows.map(size));
  const barWidth = Math.max(4, width - keyWidth - (by === 'model' ? 46 : 34));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text bold>By </Text>
        {BREAKDOWNS.map((b) => (
          <Text key={b} bold={b === by} color={b === by ? t.accent : undefined} dimColor={b !== by}>
            {b}{' '}
          </Text>
        ))}
        {rows.length > ROWS ? (
          <Text dimColor>
            {' '}
            {scroll + 1}-{scroll + shown.length} of {rows.length}
          </Text>
        ) : null}
      </Text>
      {shown.map((r) => {
        const bar = meter(max ? size(r) / max : 0, barWidth);
        const key = r.key.length > keyWidth ? `${r.key.slice(0, keyWidth - 1)}…` : r.key;
        return (
          <Text key={r.key} wrap="truncate-end">
            {key.padEnd(keyWidth)}
            <Text dimColor>
              {String(r.calls).padStart(6)} calls {compactTokens(totalTokens(r.usage)).padStart(6)}{' '}
              tok
            </Text>
            <Text color={r.costUsd > 0 ? t.remote : t.local}>{usd(r.costUsd).padStart(9)} </Text>
            {by === 'model' ? (
              <Text dimColor>
                {(r.tokensPerSecond !== undefined ? speedLabel(r.tokensPerSecond) : '').padStart(
                  11,
                )}{' '}
              </Text>
            ) : null}
            <Text color={r.costUsd > 0 ? t.remote : t.local}>{bar.filled}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
