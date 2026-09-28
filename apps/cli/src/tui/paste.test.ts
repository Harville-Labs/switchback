import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { osc52, pickCopy } from './clipboard.ts';
import {
  chipBefore,
  cleanPaste,
  expandPastes,
  noPastes,
  pastedPath,
  pasteInsertion,
  pathInsertion,
} from './paste.ts';

describe('cleanPaste', () => {
  test('drops terminal colors and control characters, keeps tabs and newlines', () => {
    expect(cleanPaste('\x1b[32mok\x1b[0m\r\n\tindented\rnext\x07\x00')).toBe(
      'ok\n\tindented\nnext',
    );
  });
  test('leaves ordinary text and unicode alone', () => {
    const text = 'const s = "héllo 👋";\n  return s;';
    expect(cleanPaste(text)).toBe(text);
  });
});

describe('big pastes become chips', () => {
  test('small pastes go in as text', () => {
    expect(pasteInsertion('a\nb', noPastes)).toEqual({ insert: 'a\nb', pastes: noPastes });
  });

  test('a big paste is one chip; submitting expands it; numbering continues', () => {
    const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const first = pasteInsertion(big, noPastes);
    expect(first.insert).toBe('[Pasted text #1 · 40 lines]');
    const second = pasteInsertion('x'.repeat(2_000), first.pastes);
    expect(second.insert).toBe('[Pasted text #2 · 2000 chars]');
    const value = `fix this:\n${first.insert}\nand ${second.insert}`;
    expect(expandPastes(value, second.pastes)).toBe(`fix this:\n${big}\nand ${'x'.repeat(2_000)}`);
  });

  test('text that merely looks like a chip is left alone', () => {
    expect(expandPastes('[Pasted text #9 · 3 lines]', noPastes)).toBe('[Pasted text #9 · 3 lines]');
  });

  test('backspace right after a chip removes all of it', () => {
    const { insert, pastes } = pasteInsertion('y\n'.repeat(20), noPastes);
    const value = `see ${insert}`;
    expect(chipBefore(value, value.length, pastes)).toBe(4);
    expect(chipBefore(value, value.length - 1, pastes)).toBeUndefined();
    expect(chipBefore(value, value.length, noPastes)).toBeUndefined();
  });
});

describe('dropped files', () => {
  test('recognizes the ways terminals paste a path', () => {
    expect(pastedPath('/Users/me/My\\ Project/a.ts')).toBe('/Users/me/My Project/a.ts');
    expect(pastedPath("'/tmp/with space.png' ")).toBe('/tmp/with space.png');
    expect(pastedPath('file:///tmp/a%20b.txt')).toBe('/tmp/a b.txt');
    expect(pastedPath('~/notes.md')).toBe('~/notes.md');
    expect(pastedPath('C:\\Users\\me\\a.ts')).toBe('C:\\Users\\me\\a.ts');
    expect(pastedPath('not a path')).toBeUndefined();
    expect(pastedPath('/a\n/b')).toBeUndefined();
  });

  test('workspace files become mentions; others stay paths', () => {
    // resolve() so the expectations hold on Windows too (drive letters).
    const files = ['/repo/src/app.ts', '/tmp/x y.log', '/home/me/n.md'].map((p) => resolve(p));
    const exists = (p: string) => files.includes(p);
    const root = resolve('/repo');
    expect(pathInsertion('/repo/src/app.ts', root, exists)).toBe('@src/app.ts ');
    expect(pathInsertion('/tmp/x y.log', root, exists)).toBe(`"${resolve('/tmp/x y.log')}" `);
    expect(pathInsertion('~/n.md', root, exists, resolve('/home/me'))).toBe(
      `${resolve('/home/me/n.md')} `,
    );
    expect(pathInsertion('/repo/missing.ts', root, exists)).toBeUndefined();
  });
});

describe('/copy', () => {
  const reply = 'Here:\n\n```ts\nconst a = 1;\n```\n\nand\n\n```sh\nbun test\n```\n';
  test('copies the reply or one code block, raw', () => {
    expect(pickCopy(reply, undefined)).toEqual({ text: reply, what: 'the last reply' });
    expect(pickCopy(reply, '2')).toEqual({ text: 'bun test', what: 'code block 2 of 2' });
    expect(pickCopy(reply, 'code')).toMatchObject({ text: 'const a = 1;' });
    expect(pickCopy(reply, '3')).toEqual({ error: 'the last reply has 2 code blocks: /copy 1…2' });
    expect(pickCopy('plain', '1')).toMatchObject({
      error: expect.stringContaining('no code blocks'),
    });
  });
  test('OSC 52 carries the text base64-encoded', () => {
    const tmux = process.env.TMUX;
    delete process.env.TMUX;
    expect(osc52('héllo')).toBe(`\x1b]52;c;${Buffer.from('héllo').toString('base64')}\x07`);
    if (tmux !== undefined) process.env.TMUX = tmux;
  });
});
