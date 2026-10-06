import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { commandMatches, parseCommand, suggestBashRules } from './bash-match.ts';
import { RuleLayers } from './layers.ts';
import { pathMatcher } from './path-match.ts';
import { PermissionPolicy, type SourcedRule, suggestRules } from './policy.ts';
import { parseRule } from './rules.ts';

const root = '/work/repo';

describe('rules', () => {
  test("parse our names and Claude Code's", () => {
    expect(parseRule('bash(git status:*)')).toMatchObject({
      target: { kind: 'bash' },
      specifier: 'git status:*',
    });
    expect(parseRule('Bash').target).toEqual({ kind: 'bash' });
    expect(parseRule('Write(src/**)').target).toEqual({ kind: 'edit' });
    expect(parseRule('Grep').target).toEqual({ kind: 'read' });
    expect(parseRule('mcp__github').target).toEqual({ kind: 'mcp', server: 'github' });
    expect(parseRule('mcp__github__*').target).toEqual({ kind: 'mcp', server: 'github' });
    expect(parseRule('mcp__github__create_issue').target).toEqual({
      kind: 'mcp',
      server: 'github',
      tool: 'create_issue',
    });
  });

  test('explain what is wrong', () => {
    expect(() => parseRule('fetchurl(x)')).toThrow('unknown tool "fetchurl"');
    expect(() => parseRule('bash()')).toThrow('empty parentheses');
    expect(() => parseRule('mcp__a(x)')).toThrow('MCP rules take no specifier');
    expect(() => parseRule('bash(x')).toThrow('expected Tool or Tool(specifier)');
  });
});

describe('bash commands', () => {
  test('split on every operator and newline', () => {
    expect(parseCommand('git status && rm -rf x; ls | wc -l\necho hi').commands).toEqual([
      'git status',
      'rm -rf x',
      'ls',
      'wc -l',
      'echo hi',
    ]);
  });

  test('substitution and file writes are opaque', () => {
    for (const c of ['echo $(id)', 'echo "$(id)"', 'echo `id`', 'diff <(ls) b', 'echo x > f'])
      expect(parseCommand(c).opaque).toBe(true);
    for (const c of ['echo x > /dev/null', 'make 2>&1', "echo '$HOME'"])
      expect(parseCommand(c).opaque).toBe(false);
  });

  test('deny matching looks through wrappers and assignments', () => {
    expect(parseCommand('sudo -n rm -rf /').bare).toEqual(['rm -rf /']);
    expect(parseCommand('FOO=1 env xargs rm x').bare).toEqual(['rm x']);
  });

  test('specifiers: exact, prefix, wildcard', () => {
    expect(commandMatches('git status', 'git status')).toBe(true);
    expect(commandMatches('git status -s', 'git status')).toBe(false);
    expect(commandMatches('git status -s', 'git status:*')).toBe(true);
    expect(commandMatches('git statusx', 'git status:*')).toBe(false);
    expect(commandMatches('npm run test:unit', 'npm run test*')).toBe(true);
    // Commands and specifiers are compared as words, quotes removed.
    const [commit] = parseCommand('git commit -m "x y"').commands;
    expect(commandMatches(commit ?? '', 'git commit -m "x y"')).toBe(true);
  });

  test('suggestions name each command by its first word or two', () => {
    expect(suggestBashRules('git status && bun test --watch | tee out.log')).toEqual([
      'bash(git status:*)',
      'bash(bun test:*)',
      'bash(tee:*)',
    ]);
    expect(suggestBashRules('echo $(id)')).toEqual(['bash(echo $(id))']);
  });
});

describe('paths', () => {
  const m = (spec: string, path: string) => pathMatcher(spec, root, '/home/me')(path);
  test('gitignore-style', () => {
    expect(m('.env', join(root, 'apps/api/.env'))).toBe(true);
    expect(m('src/**', join(root, 'src/a/b.ts'))).toBe(true);
    expect(m('src/**', join(root, 'lib/src/a.ts'))).toBe(false);
    expect(m('/build/', join(root, 'build/x.js'))).toBe(true);
    expect(m('secrets/', join(root, 'secrets'))).toBe(true);
    expect(m('~/.ssh/**', '/home/me/.ssh/id_ed25519')).toBe(true);
    expect(m('//etc/hosts', '/etc/hosts')).toBe(true);
    expect(m('*.ts', '/elsewhere/a.ts')).toBe(false);
  });
});

describe('policy', () => {
  const rules = (list: [SourcedRule['behavior'], string][]): SourcedRule[] =>
    list.map(([behavior, rule]) => ({ behavior, rule, source: 'test' }));
  const bash = (command: string) => ({
    name: 'bash',
    category: 'bash' as const,
    input: { command },
  });

  test('deny beats ask beats allow', () => {
    const p = new PermissionPolicy(
      rules([
        ['allow', 'bash'],
        ['ask', 'bash(git push:*)'],
        ['deny', 'bash(rm:*)'],
      ]),
    );
    expect(p.evaluate(bash('ls'), root)?.behavior).toBe('allow');
    expect(p.evaluate(bash('git push origin'), root)?.behavior).toBe('ask');
    expect(p.evaluate(bash('ls && sudo rm -rf x'), root)?.behavior).toBe('deny');
  });

  test('allow needs every command covered, by any mix of rules', () => {
    const p = new PermissionPolicy(
      rules([
        ['allow', 'bash(git status:*)'],
        ['allow', 'bash(ls)'],
      ]),
    );
    expect(p.evaluate(bash('git status && ls'), root)?.behavior).toBe('allow');
    expect(p.evaluate(bash('git status; rm x'), root)).toBeUndefined();
    expect(p.evaluate(bash('git status > out.txt'), root)).toBeUndefined();
    expect(p.evaluate(bash('PATH=/tmp git status'), root)).toBeUndefined();
  });

  test('read rules cover the search tools, edit rules both edit tools', () => {
    const p = new PermissionPolicy(
      rules([
        ['deny', 'read(.env)'],
        ['allow', 'edit(src/**)'],
      ]),
    );
    expect(
      p.evaluate({ name: 'read', category: 'read', input: { path: '.env' } }, root)?.behavior,
    ).toBe('deny');
    expect(
      p.evaluate({ name: 'write', category: 'edit', input: { path: 'src/a.ts' } }, root)?.behavior,
    ).toBe('allow');
    expect(
      p.evaluate({ name: 'edit', category: 'edit', input: { path: 'docs/a.md' } }, root),
    ).toBeUndefined();
    expect(p.hides(join(root, 'pkg/.env'), root)).toBe(true);
    expect(p.hides(join(root, 'pkg/env.ts'), root)).toBe(false);
  });

  test('MCP rules by server or tool', () => {
    const p = new PermissionPolicy(
      rules([
        ['allow', 'mcp__gh'],
        ['deny', 'mcp__gh__delete_repo'],
      ]),
    );
    const call = (name: string) => ({ name, category: 'mcp' as const, input: {} });
    expect(p.evaluate(call('mcp__gh__list'), root)?.behavior).toBe('allow');
    expect(p.evaluate(call('mcp__gh__delete_repo'), root)?.behavior).toBe('deny');
    expect(p.evaluate(call('mcp__other__list'), root)).toBeUndefined();
  });

  test('always grants what the call needs, no more', () => {
    expect(suggestRules(bash('git log -3'))).toEqual(['bash(git log:*)']);
    expect(suggestRules({ name: 'mcp__gh__list', category: 'mcp', input: {} })).toEqual([
      'mcp__gh',
    ]);
    expect(suggestRules({ name: 'write', category: 'edit', input: { path: 'a' } })).toEqual([
      'edit',
    ]);
  });
});

describe('layers', () => {
  test('add up, keep their source, and an org can keep only its own allow rules', () => {
    const layers = new RuleLayers();
    const rest = layers.take(
      { permissions: { bash: 'ask', deny: ['bash(rm:*)'], allow: ['bash(ls)'] } },
      'organization',
      true,
    );
    expect(rest).toEqual({ permissions: { bash: 'ask' } });
    layers.take({ permissions: { allow: ['bash(git:*)'], deny: ['read(.env)'] } }, 'user.json');
    layers.take({ permissions: { allow: ['bash(ls)'] } }, 'project.json');
    const all = layers.result(false);
    expect(all.lists).toEqual({
      allow: ['bash(ls)', 'bash(git:*)'],
      ask: [],
      deny: ['bash(rm:*)', 'read(.env)'],
    });
    expect(all.sourced.find((r) => r.rule === 'read(.env)')?.source).toBe('user.json');
    const orgOnly = layers.result(true);
    expect(orgOnly.lists.allow).toEqual(['bash(ls)']);
    expect(orgOnly.lists.deny).toEqual(['bash(rm:*)', 'read(.env)']);
    expect(orgOnly.ignored.map((r) => r.rule)).toEqual(['bash(git:*)']);
  });
});
