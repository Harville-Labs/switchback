import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateEscalationCost } from './estimate.ts';
import { cacheHitRate, type LedgerEntry, UsageLedger } from './ledger.ts';

const now = () => new Date('2026-09-27T12:00:00Z');

/** A fixture ledger spanning this month, last week, and today. */
function fixture(): LedgerEntry[] {
  const entry = (
    ts: string,
    tier: 'local' | 'remote',
    model: string,
    costUsd: number,
    rule?: string,
    agent?: string,
    cacheReadTokens = 0,
  ): LedgerEntry => ({
    ts,
    sessionId: 's1',
    tier,
    model: { provider: tier === 'local' ? 'ollama' : 'openai', model },
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens, cacheWriteTokens: 0 },
    costUsd,
    savingsUsd: tier === 'local' ? 0.01 : 0,
    ...(rule ? { rule } : {}),
    ...(agent ? { agent } : {}),
  });
  return [
    entry('2026-09-02T10:00:00Z', 'remote', 'gpt-6-sol', 0.5, 'escalation', 'build'), // month only
    entry('2026-09-22T10:00:00Z', 'local', 'qwen', 0, 'default', 'build'),
    entry('2026-09-23T10:00:00Z', 'remote', 'gpt-6-sol', 0.2, 'context-overflow', 'build', 3000),
    entry('2026-09-27T09:00:00Z', 'remote', 'gpt-6-sol', 0.1, 'escalation', 'explore', 1000),
    entry('2026-09-27T10:00:00Z', 'local', 'qwen', 0, 'default', 'explore'),
    entry('2026-09-27T11:00:00Z', 'local', 'qwen', 0), // written before 0.4
  ];
}

function ledgerWith(entries: LedgerEntry[]) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ledger-'));
  const file = join(dir, 'usage.jsonl');
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));
  const ledger = new UsageLedger(file, {}, undefined, now);
  rmSync(dir, { recursive: true, force: true });
  return ledger;
}

describe('usage breakdowns', () => {
  test('group by rule, agent, and model for each period', () => {
    const ledger = ledgerWith(fixture());
    const month = ledger.report({}, 'month');
    expect(month.period).toEqual({ from: '2026-09-01', to: '2026-09-27' });
    expect(month.byRule?.map((r) => [r.key, r.calls, +r.costUsd.toFixed(2)])).toEqual([
      ['escalation', 2, 0.6],
      ['context-overflow', 1, 0.2],
      ['default', 2, 0],
      ['unrecorded', 1, 0],
    ]);
    expect(month.byModel?.map((r) => [r.key, r.calls])).toEqual([
      ['openai/gpt-6-sol', 3],
      ['ollama/qwen', 3],
    ]);

    const week = ledger.report({}, 'week');
    expect(week.period.from).toBe('2026-09-21');
    expect(week.byAgent?.map((r) => [r.key, r.calls, +r.costUsd.toFixed(2)])).toEqual([
      ['build', 2, 0.2],
      ['explore', 2, 0.1],
      ['unrecorded', 1, 0],
    ]);

    const today = ledger.report({}, 'today');
    expect(today.byTier.remote.costUsd).toBeCloseTo(0.1);
    expect(today.byRule?.map((r) => r.key)).toEqual(['escalation', 'default', 'unrecorded']);
  });

  test('remote cache hit rate counts cached reads against all remote input', () => {
    const week = ledgerWith(fixture()).report({}, 'week');
    // Two remote calls: 2000 uncached + 4000 cached input tokens.
    expect(week.remoteCacheHitRate).toBeCloseTo(4000 / 6000);
    expect(cacheHitRate({ inputTokens: 0, outputTokens: 5 })).toBeUndefined();
  });

  test('records rule and agent on new entries', () => {
    const ledger = new UsageLedger(undefined, {}, undefined, now);
    const e = ledger.record(
      's',
      'remote',
      { provider: 'p', model: 'm' },
      { inputTokens: 1, outputTokens: 1 },
      { rule: 'sticky', agent: 'build' },
    );
    expect(e).toMatchObject({ rule: 'sticky', agent: 'build' });
  });
});

describe('escalation estimate', () => {
  const price = { input: 2, output: 10, cacheRead: 0.2 };

  test('one call is prompt plus expected output at list price', () => {
    const usd = estimateEscalationCost({
      price,
      inputTokens: 10_000,
      outputTokens: 1_000,
      calls: 1,
    });
    expect(usd).toBeCloseTo((10_000 * 2 + 1_000 * 10) / 1e6);
  });

  test('sticky follow-ups mostly read the cached prefix', () => {
    const one = estimateEscalationCost({ price, inputTokens: 50_000, calls: 1 }) ?? 0;
    const three = estimateEscalationCost({ price, inputTokens: 50_000, calls: 3 }) ?? 0;
    expect(three).toBeGreaterThan(one);
    // Far less than paying the full prompt three times.
    expect(three).toBeLessThan(one * 2);
  });

  test('unknown price means no estimate', () => {
    expect(estimateEscalationCost({ price: undefined, inputTokens: 1, calls: 1 })).toBeUndefined();
  });
});
