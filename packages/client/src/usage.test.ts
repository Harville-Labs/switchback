import { describe, expect, test } from 'bun:test';
import type { UsageRow } from '@switchback/protocol';
import { bucketLabel, columnChart, meter, rangeLabel, usageBuckets, usageRange } from './usage.ts';

const today = '2026-10-20';

describe('usage ranges', () => {
  test('each span covers the current period, cut off at today', () => {
    expect(usageRange('today', today)).toEqual({ from: today, to: today });
    expect(usageRange('week', today)).toEqual({ from: '2026-10-14', to: today });
    expect(usageRange('month', today)).toEqual({ from: '2026-10-01', to: today });
    expect(usageRange('year', today)).toEqual({ from: '2026-01-01', to: today });
    expect(usageRange('all', today).to).toBe(today);
  });

  test('stepping back gives whole earlier periods, across year ends', () => {
    expect(usageRange('today', today, 1)).toEqual({ from: '2026-10-19', to: '2026-10-19' });
    expect(usageRange('week', today, 1)).toEqual({ from: '2026-10-07', to: '2026-10-13' });
    expect(usageRange('month', today, 1)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(usageRange('month', today, 10)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(usageRange('month', '2028-03-05', 1)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(usageRange('year', today, 1)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  test('a custom range steps back by its own length', () => {
    const custom = { from: '2026-10-01', to: '2026-10-10' };
    expect(usageRange('custom', today, 0, custom)).toEqual(custom);
    expect(usageRange('custom', today, 1, custom)).toEqual({
      from: '2026-09-21',
      to: '2026-09-30',
    });
  });

  test('labels read the way people say them', () => {
    expect(rangeLabel('today', usageRange('today', today), today)).toBe('Today');
    expect(rangeLabel('today', usageRange('today', today, 1), today)).toBe('Yesterday');
    expect(rangeLabel('today', usageRange('today', today, 2), today)).toBe('Oct 18, 2026');
    expect(rangeLabel('month', usageRange('month', today, 1), today)).toBe('September 2026');
    expect(rangeLabel('week', usageRange('week', today), today)).toBe('Oct 14 – Oct 20, 2026');
    expect(rangeLabel('custom', { from: '2025-12-30', to: '2026-01-02' }, today)).toBe(
      'Dec 30, 2025 – Jan 2, 2026',
    );
    expect(rangeLabel('all', usageRange('all', today), today)).toBe('All time');
  });
});

const row = (key: string, costUsd: number): UsageRow => ({
  key,
  calls: 1,
  usage: { inputTokens: 100, outputTokens: 10 },
  costUsd,
  savingsUsd: 0.5,
});

describe('usage chart', () => {
  test('short ranges get one bucket per day, quiet days included', () => {
    const buckets = usageBuckets([row('2026-10-15', 1), row('2026-10-17', 2)], {
      from: '2026-10-14',
      to: '2026-10-17',
    });
    expect(buckets.map((b) => [b.key, b.costUsd])).toEqual([
      ['2026-10-14', 0],
      ['2026-10-15', 1],
      ['2026-10-16', 0],
      ['2026-10-17', 2],
    ]);
    expect(buckets[1]?.tokens).toBe(110);
  });

  test('a year goes by month, empty months included', () => {
    const buckets = usageBuckets([row('2026-04-03', 1)], usageRange('year', '2026-06-09'));
    expect(buckets.map((b) => b.key)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
  });

  test('ranges over a year go by month from the first month with calls', () => {
    const buckets = usageBuckets(
      [row('2025-11-03', 1), row('2025-11-20', 1), row('2026-02-01', 3)],
      usageRange('all', '2026-03-09'),
    );
    expect(buckets.map((b) => [b.key, b.costUsd, b.calls])).toEqual([
      ['2025-11', 2, 2],
      ['2025-12', 0, 0],
      ['2026-01', 0, 0],
      ['2026-02', 3, 1],
      ['2026-03', 0, 0],
    ]);
  });

  test('columns scale to the largest value and small values still show', () => {
    expect(columnChart([0, 1, 100, 50], 2)).toEqual(['  █ ', ' ▁██']);
    expect(columnChart([0, 0], 1)).toEqual(['  ']);
  });

  test('axis labels name the day or the month', () => {
    expect(bucketLabel('2026-10-14')).toBe('Oct 14');
    expect(bucketLabel('2025-11')).toBe('Nov 2025');
  });

  test('a meter fills in eighths and never overflows', () => {
    expect(meter(0.5, 4)).toEqual({ filled: '██', empty: '░░' });
    expect(meter(0.1, 4)).toEqual({ filled: '▍', empty: '░░░' });
    expect(meter(2, 3)).toEqual({ filled: '███', empty: '' });
  });
});
