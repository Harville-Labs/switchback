import { describe, expect, test } from 'bun:test';
import type { UsageRange, UsageReport, UsageRow } from '@switchback/protocol';
import { render } from 'ink-testing-library';
import { UsageDashboard } from './UsageDashboard.tsx';

const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const tick = () => new Promise((r) => setTimeout(r, 20));
const today = '2026-10-20';

const row = (key: string, calls: number, costUsd: number): UsageRow => ({
  key,
  calls,
  usage: { inputTokens: 1000 * calls, outputTokens: 100 * calls },
  costUsd,
  savingsUsd: 0,
});

/** A report with one remote call on the range's last day, recording which ranges were asked for. */
function fakeLoad(asked: UsageRange[]) {
  return (range: UsageRange): UsageReport => {
    asked.push(range);
    return {
      period: range,
      byTier: {
        local: { usage: { inputTokens: 5000, outputTokens: 500 }, costUsd: 0 },
        remote: { usage: { inputTokens: 1000, outputTokens: 100 }, costUsd: 0.25 },
      },
      estimatedSavingsUsd: 0.75,
      referenceModel: 'claude-opus-5',
      budget: { dailyUsd: 1, spentTodayUsd: 0.9, spentMonthUsd: 2 },
      byRule: [row('escalation', 1, 0.25), row('default', 5, 0)],
      byAgent: [row('build', 6, 0.25)],
      byModel: [row('openai/gpt-6-sol', 1, 0.25)],
      byDay: [row(range.to, 6, 0.25)],
    };
  };
}

describe('usage dashboard', () => {
  test('shows spend, savings, budget, and the breakdown for the starting period', async () => {
    const ui = render(
      <UsageDashboard load={fakeLoad([])} today={today} initialSpan="week" onExit={() => {}} />,
    );
    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Oct 14 – Oct 20, 2026');
    expect(frame).toContain('Spent $0.25');
    expect(frame).toContain('Saved ~$0.75 (75% vs. all-remote on claude-opus-5)');
    expect(frame).toContain('90%');
    expect(frame).toContain('no limit set');
    expect(frame).toContain('escalation');
    expect(frame).toContain('Oct 20');
  });

  test('arrows step through earlier periods and number keys switch the span', async () => {
    const asked: UsageRange[] = [];
    const ui = render(
      <UsageDashboard load={fakeLoad(asked)} today={today} initialSpan="month" onExit={() => {}} />,
    );
    await tick();
    ui.stdin.write(LEFT);
    await tick();
    expect(ui.lastFrame()).toContain('September 2026');
    ui.stdin.write(LEFT);
    await tick();
    ui.stdin.write(RIGHT);
    await tick();
    expect(ui.lastFrame()).toContain('September 2026');
    ui.stdin.write(RIGHT);
    ui.stdin.write(RIGHT); // already at the current month; stays there
    await tick();
    expect(ui.lastFrame()).toContain('October 2026');
    ui.stdin.write('1');
    await tick();
    expect(ui.lastFrame()).toContain('Today');
    ui.stdin.write(LEFT);
    await tick();
    expect(ui.lastFrame()).toContain('Yesterday');
    expect(asked.at(-1)).toEqual({ from: '2026-10-19', to: '2026-10-19' });
  });

  test('b switches the breakdown, m the chart, and q quits', async () => {
    let exited = false;
    const ui = render(
      <UsageDashboard
        load={fakeLoad([])}
        today={today}
        onExit={() => {
          exited = true;
        }}
      />,
    );
    await tick();
    ui.stdin.write('b');
    await tick();
    expect(ui.lastFrame()).toContain('build');
    ui.stdin.write('m');
    await tick();
    expect(ui.lastFrame()).toContain('Saved by running locally');
    ui.stdin.write('q');
    await tick();
    expect(exited).toBe(true);
  });

  test('a custom range is offered as its own span', async () => {
    const custom = { from: '2026-10-01', to: '2026-10-10' };
    const ui = render(
      <UsageDashboard
        load={fakeLoad([])}
        today={today}
        initialSpan="custom"
        custom={custom}
        onExit={() => {}}
      />,
    );
    await tick();
    expect(ui.lastFrame()).toContain('6 Custom');
    expect(ui.lastFrame()).toContain('Oct 1 – Oct 10, 2026');
    ui.stdin.write(LEFT);
    await tick();
    expect(ui.lastFrame()).toContain('Sep 21 – Sep 30, 2026');
  });

  test('a period with no calls says so instead of drawing an empty chart', async () => {
    const empty = (range: UsageRange): UsageReport => ({
      ...fakeLoad([])(range),
      byDay: [],
    });
    const ui = render(<UsageDashboard load={empty} today={today} onExit={() => {}} />);
    await tick();
    expect(ui.lastFrame()).toContain('No model calls in this period');
  });
});
