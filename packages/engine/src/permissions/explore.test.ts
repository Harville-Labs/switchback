import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exploration } from './explore.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'switchback-explore-')));
mkdirSync(join(root, 'src'));
writeFileSync(join(root, 'src', 'a.ts'), 'export {};\n');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const explores = (line: string) => exploration(line, root) !== undefined;

describe('exploration', () => {
  test('listing, reading, searching, and read-only git in the workspace explore', () => {
    for (const line of [
      'ls',
      'ls -la src',
      'pwd',
      'cat src/a.ts',
      'head -n 20 src/a.ts',
      'grep -rn "export" src',
      'rg --type ts foo',
      'find . -name "*.ts"',
      'cd src && ls && cat a.ts',
      'ls | wc -l',
      'git status',
      'git diff HEAD~1 -- src',
      'git log --oneline -5',
      'git --no-pager show HEAD:src/a.ts',
      'git branch',
      'git branch --show-current',
      'git stash list',
      'grep foo src/a.ts 2>/dev/null',
    ])
      expect({ line, explores: explores(line) }).toEqual({ line, explores: true });
  });

  test('anything that reaches outside the workspace does not', () => {
    for (const line of [
      'cat /etc/hosts',
      'ls ..',
      'cd .. && ls',
      'cd',
      'cd -',
      'cat ~/.ssh/id_ed25519',
      'grep -f/etc/passwd x',
      'grep --file=../x y',
      'cat $HOME/.ssh/config',
      'git -C /tmp status',
      'find / -name x',
    ])
      expect({ line, explores: explores(line) }).toEqual({ line, explores: false });
  });

  test('writing, running other programs, and unknown commands do not', () => {
    for (const line of [
      'rm -rf src',
      'ls > out.txt',
      'cat $(which ls)',
      'echo `id`',
      'find . -exec rm {} ;',
      'find . -name x -delete',
      'rg --pre ./x foo',
      'git log --output=x',
      'git -c core.pager=sh log',
      'git branch new-feature',
      'git commit -m x',
      'git push',
      'git stash',
      'sudo cat src/a.ts',
      'ls | xargs rm',
      'ls | sh',
      'FOO=1 ls',
    ])
      expect({ line, explores: explores(line) }).toEqual({ line, explores: false });
  });

  test('sed explores only when its script prints', () => {
    for (const line of [
      "sed -n '1,20p' src/a.ts",
      "sed -n '/export/p' src/a.ts",
      "sed 's/foo/bar/g' src/a.ts",
      "sed -E -e 's/a+/b/' -e '3q' src/a.ts",
      'git diff | sed -n 5,10p',
    ])
      expect({ line, explores: explores(line) }).toEqual({ line, explores: true });
    for (const line of [
      "sed -i 's/a/b/' src/a.ts",
      "sed -i '' 's/a/b/' src/a.ts",
      "sed 's/a/b/w out.txt' src/a.ts",
      "sed 's/a/b/e' src/a.ts",
      "sed 'w out.txt' src/a.ts",
      "sed '1r /etc/passwd' src/a.ts",
      "sed 's|a|b|' src/a.ts",
      'sed -f script.sed src/a.ts',
      "sed -n '1p' /etc/hosts",
    ])
      expect({ line, explores: explores(line) }).toEqual({ line, explores: false });
  });

  test('cd moves where later commands read from', () => {
    expect(exploration('cd src && cat a.ts', root)?.paths).toEqual([
      join(root, 'src'),
      join(root, 'src', 'a.ts'),
    ]);
  });

  test('a content search over a directory is flagged; one file or a listing is not', () => {
    expect(exploration('grep -rn foo src', root)?.searchesDirectory).toBe(true);
    expect(exploration('git grep foo', root)?.searchesDirectory).toBe(true);
    expect(exploration('grep foo src/a.ts', root)?.searchesDirectory).toBe(false);
    expect(exploration('ls src', root)?.searchesDirectory).toBe(false);
  });
});
