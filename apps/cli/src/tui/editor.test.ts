import { describe, expect, test } from 'bun:test';
import {
  at,
  backspace,
  completeMention,
  deleteToLineStart,
  deleteWord,
  empty,
  insert,
  mentionAt,
  moveVertical,
  position,
  rankFiles,
} from './editor.ts';

describe('editing', () => {
  test('insert normalizes pasted line endings and moves the cursor', () => {
    const s = insert(empty, 'a\r\nb\rc');
    expect(s).toEqual({ value: 'a\nb\nc', cursor: 5 });
  });

  test('backspace, word delete, and line delete', () => {
    expect(backspace(at('abc'))).toEqual({ value: 'ab', cursor: 2 });
    expect(backspace({ value: 'abc', cursor: 0 }).value).toBe('abc');
    expect(deleteWord(at('fix the  parser  '))).toEqual({ value: 'fix the  ', cursor: 9 });
    expect(deleteToLineStart(at('one\ntwo three'))).toEqual({ value: 'one\n', cursor: 4 });
  });

  test('vertical movement keeps the column and reports the edges', () => {
    const s = { value: 'first line\nab\nthird', cursor: 8 };
    expect(position(s)).toMatchObject({ line: 0, column: 8 });
    const down = moveVertical(s, 1);
    expect(down && position(down)).toMatchObject({ line: 1, column: 2 });
    expect(moveVertical(s, -1)).toBeUndefined();
    expect(moveVertical(at('single'), 1)).toBeUndefined();
  });
});

describe('mentions', () => {
  test('finds the @token under the cursor and completes it', () => {
    const s = at('look at @src/ma');
    expect(mentionAt(s)).toEqual({ start: 8, query: 'src/ma' });
    expect(completeMention(s, 'src/main.ts')).toEqual({
      value: 'look at @src/main.ts ',
      cursor: 21,
    });
    expect(mentionAt(at('email me@home'))).toBeUndefined();
    expect(mentionAt(at('done @a.ts '))).toBeUndefined();
  });

  test('ranks file-name matches above scattered path matches', () => {
    const files = [
      'docs/main-notes.md',
      'apps/cli/src/main.ts',
      'packages/engine/src/manager.ts',
      'README.md',
    ];
    expect(rankFiles(files, 'main')[0]).toBe('apps/cli/src/main.ts');
    expect(rankFiles(files, 'eng/man')).toEqual(['packages/engine/src/manager.ts']);
    expect(rankFiles(files, 'zzz')).toEqual([]);
  });
});
