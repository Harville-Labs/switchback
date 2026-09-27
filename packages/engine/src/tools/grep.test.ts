import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepJs, grepRipgrep } from './fs.ts';

let root: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-grep-')));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(root, 'build'));
  writeFileSync(join(root, 'src', 'a.ts'), 'const retry = 3;\nfunction retryLater() {}\n');
  writeFileSync(join(root, 'src', 'b.md'), 'Retry policy\n');
  writeFileSync(join(root, 'node_modules', 'dep', 'x.js'), 'retry\n');
  writeFileSync(join(root, 'build', 'out.js'), 'retry\n');
  writeFileSync(join(root, '.gitignore'), 'build/\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const rg = Bun.which('rg');

describe('grepJs', () => {
  test('finds matches, skips node_modules, honors glob and case', async () => {
    expect(await grepJs({ pattern: 'retry', glob: 'src/**' }, root, root)).toEqual([
      'src/a.ts:1: const retry = 3;',
      'src/a.ts:2: function retryLater() {}',
    ]);
    expect(
      await grepJs({ pattern: 'retry', ignoreCase: true, glob: '**/*.md' }, root, root),
    ).toEqual(['src/b.md:1: Retry policy']);
  });
});

describe.skipIf(!rg)('grepRipgrep', () => {
  test('matches the JS results and honors .gitignore outside a git repo', async () => {
    const out = await grepRipgrep(rg as string, { pattern: 'retry' }, root, root);
    expect(out?.sort()).toEqual([
      'src/a.ts:1: const retry = 3;',
      'src/a.ts:2: function retryLater() {}',
    ]);
  });

  test('returns undefined for patterns only JavaScript supports, so callers fall back', async () => {
    expect(
      await grepRipgrep(rg as string, { pattern: 'retry(?=Later)' }, root, root),
    ).toBeUndefined();
    expect(await grepJs({ pattern: 'retry(?=Later)' }, root, root)).toEqual([
      'src/a.ts:2: function retryLater() {}',
    ]);
  });

  test('searches relative to a subdirectory but reports workspace paths', async () => {
    const out = await grepRipgrep(rg as string, { pattern: 'const' }, join(root, 'src'), root);
    expect(out).toEqual(['src/a.ts:1: const retry = 3;']);
  });
});
