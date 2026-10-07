import { describe, expect, test } from 'bun:test';
import { diffStats, displayRows, exploreSummary, toolResult, toolTitle } from './tool-display.ts';
import type { ViewItem } from './view-state.ts';

type Tool = Extract<ViewItem, { kind: 'tool' }>;
const tool = (name: string, output: string, extra: Partial<Tool> = {}): Tool => ({
  kind: 'tool',
  id: `t-${name}-${output.length}`,
  name,
  input: {},
  status: 'ok',
  output,
  ...extra,
});

describe('tool titles', () => {
  test('name what the call does and to what', () => {
    expect(toolTitle('bash', { command: 'ls -la' })).toEqual({ verb: 'Bash', target: 'ls -la' });
    expect(toolTitle('edit', { path: 'a.ts' })).toEqual({ verb: 'Update', target: 'a.ts' });
    expect(toolTitle('grep', { pattern: 'foo', path: 'src' })).toEqual({
      verb: 'Search',
      target: '"foo" in src',
    });
    expect(toolTitle('mcp__github__create_issue', { name: 'x' }).verb).toBe(
      'github · create_issue',
    );
  });
});

describe('tool results', () => {
  test('read, list, and search say how much they found', () => {
    expect(toolResult(tool('read', '     1\ta\n     2\tb\n[40 more lines]')).summary).toBe(
      '2 lines of 42',
    );
    expect(toolResult(tool('glob', 'a.ts\nb.ts\nc.ts')).summary).toBe('3 files');
    expect(toolResult(tool('glob', 'no matches')).summary).toBe('No files');
    expect(toolResult(tool('grep', 'a.ts:1: foo\na.ts:9: foo\nb.ts:2: foo')).summary).toBe(
      '3 matches in 2 files',
    );
  });

  test('a command shows what it printed, and its exit code when it failed', () => {
    const ok = toolResult(tool('bash', 'stdout:\none\ntwo\nthree\nfour\nfive\nexit code: 0'));
    expect(ok).toMatchObject({ body: ['one', 'two', 'three'], more: 2, tone: 'ok' });
    expect(ok.summary).toBeUndefined();
    const failed = toolResult(tool('bash', 'stderr:\nboom\nexit code: 2'));
    expect(failed).toMatchObject({ summary: 'Exit code 2', body: ['boom'], tone: 'error' });
    expect(toolResult(tool('bash', 'exit code: 0')).summary).toBe('No output');
  });

  test('edits count their lines', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n same';
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1, created: false });
    expect(toolResult(tool('edit', 'edited x', { diff })).summary).toBe('2 additions, 1 removal');
    const created = '--- a/y\n+++ b/y\n@@ -0,0 +1,2 @@\n+a\n+b';
    expect(toolResult(tool('write', 'wrote y', { diff: created })).summary).toBe('Wrote 2 lines');
  });

  test('refusals and failures say so', () => {
    expect(
      toolResult(tool('bash', 'The user denied this action.', { status: 'error', denied: true }))
        .summary,
    ).toBe('Not run: declined');
    expect(toolResult(tool('read', 'x.ts does not exist', { status: 'error' }))).toMatchObject({
      summary: 'x.ts does not exist',
      tone: 'error',
    });
  });
});

describe('display rows', () => {
  test('runs of looking around fold into one block; anything else breaks the run', () => {
    const items: ViewItem[] = [
      tool('read', '     1\ta'),
      tool('grep', 'no matches'),
      tool('bash', 'exit code: 0'),
      tool('read', '     1\tb'),
      tool('glob', 'missing', { status: 'error' }),
    ];
    const rows = displayRows(items);
    expect(rows.map((r) => r.kind)).toEqual(['explore', 'item', 'item', 'item']);
    const first = rows[0];
    if (first?.kind !== 'explore') throw new Error('expected a block');
    expect(exploreSummary(first.calls)).toBe('read 1 file · 1 search');
  });
});
