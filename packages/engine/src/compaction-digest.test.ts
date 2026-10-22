import { describe, expect, test } from 'bun:test';
import type { Message } from '@switchback/protocol';
import { renderForSummary } from './compaction.ts';
import {
  chunkBlocks,
  historyRecord,
  mergeCalls,
  mergeRequest,
  staleCalls,
  withoutRecord,
} from './compaction-digest.ts';

const user = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] });
const call = (id: string, name: string, input: object): Message => ({
  role: 'assistant',
  parts: [{ type: 'tool_call', id, name, input }],
});
const result = (callId: string, content: string, isError = false): Message => ({
  role: 'user',
  parts: [{ type: 'tool_result', callId, content, ...(isError ? { isError } : {}) }],
});

describe('staleCalls', () => {
  test('a read is stale once the file is read, written, or edited again', () => {
    const ms = [
      call('r1', 'read', { path: 'a.ts' }),
      call('e1', 'edit', { path: 'a.ts', oldString: 'x', newString: 'y' }),
      call('r2', 'read', { path: 'b.ts' }),
      call('r3', 'read', { path: 'a.ts' }),
    ];
    expect([...staleCalls(ms)]).toEqual(['r1']);
  });

  test('the same call made twice keeps only the later output', () => {
    const ms = [
      call('b1', 'bash', { command: 'bun test' }),
      call('b2', 'bash', { command: 'git status' }),
      call('b3', 'bash', { command: 'bun test' }),
    ];
    expect([...staleCalls(ms)]).toEqual(['b1']);
  });

  test('the summarizer sees a note in place of stale output', () => {
    const ms = [call('r1', 'read', { path: 'a.ts' }), result('r1', 'old contents')];
    const blocks = renderForSummary(ms, new Set(['r1']));
    expect(blocks.join('\n')).toContain('superseded by a later call');
    expect(blocks.join('\n')).not.toContain('old contents');
  });
});

describe('historyRecord', () => {
  test('keeps requests, changed and read files, and failed commands word for word', () => {
    const record = historyRecord([
      user('fix the parser'),
      call('r1', 'read', { path: 'src/parse.ts' }),
      call('r2', 'read', { path: 'README.md' }),
      call('e1', 'edit', { path: 'src/parse.ts', oldString: 'a', newString: 'b' }),
      call('b1', 'bash', { command: 'bun test' }),
      result('b1', 'exit code: 1', true),
      call('b2', 'bash', { command: 'bun run lint' }),
      result('b2', 'exit code: 0'),
    ]);
    expect(record).toBe(
      [
        '## Record (from the transcript, word for word)',
        'User requests, oldest first:',
        '- fix the parser',
        'Files changed:',
        '- src/parse.ts',
        'Files read:',
        '- README.md',
        'Commands that failed:',
        '- `bun test`',
      ].join('\n'),
    );
  });

  test('is empty when there is nothing to record', () => {
    expect(historyRecord([])).toBe('');
  });

  test('comes off a summary so the next compaction rebuilds it', () => {
    const summary = `- working on the parser\n\n${historyRecord([user('fix it')])}`;
    expect(withoutRecord(summary)).toBe('- working on the parser');
    expect(withoutRecord('no record here')).toBe('no record here');
  });
});

describe('planning summarizer calls', () => {
  test('chunks keep blocks in order within the budget and cut a block bigger than it', () => {
    const chunks = chunkBlocks(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(400)], 20);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${'a'.repeat(40)}\n\n${'b'.repeat(40)}`);
    expect(chunks[1]).toEndWith('... (truncated)');
  });

  test('merges count only the groups with more than one summary', () => {
    expect(mergeCalls(1, 4)).toBe(0);
    expect(mergeCalls(4, 4)).toBe(1);
    // 5 → [4, 1] → one call, then 2 → one call.
    expect(mergeCalls(5, 4)).toBe(2);
    // 9 → 5 (four calls) → 3 (two) → 2 (one) → 1 (one).
    expect(mergeCalls(9, 2)).toBe(8);
  });

  test('a merge request numbers the parts oldest first', () => {
    const request = mergeRequest(['first', 'second']);
    expect(request.indexOf('<part n="1">\nfirst')).toBeLessThan(request.indexOf('<part n="2">'));
  });
});
