import { expect, test } from 'bun:test';
import { MAX_PROBLEMS, type Problem, problemsText } from './problems.ts';

const p = (path: string, line: number, severity: Problem['severity'], message = 'x'): Problem => ({
  path,
  line,
  column: 1,
  severity,
  message,
});

test("the active file's problems come first, then errors before warnings", () => {
  const text = problemsText(
    [
      p('b.ts', 3, 'warning'),
      p('a.ts', 9, 'warning'),
      p('c.ts', 1, 'error'),
      p('b.ts', 1, 'error'),
    ],
    'b.ts',
  );
  expect(text.split('\n').map((l) => l.split(' ')[0])).toEqual([
    'b.ts:1:1',
    'b.ts:3:1',
    'c.ts:1:1',
    'a.ts:9:1',
  ]);
});

test('each line names the place, severity, message, and source', () => {
  expect(problemsText([{ ...p('a.ts', 2, 'error', 'no such name'), source: 'ts' }])).toBe(
    'a.ts:2:1 error: no such name (ts)',
  );
});

test('problems past the limit are counted, not listed', () => {
  const many = Array.from({ length: MAX_PROBLEMS + 5 }, (_, i) => p('a.ts', i + 1, 'error'));
  const lines = problemsText(many).split('\n');
  expect(lines).toHaveLength(MAX_PROBLEMS + 1);
  expect(lines.at(-1)).toBe('… and 5 more');
});
