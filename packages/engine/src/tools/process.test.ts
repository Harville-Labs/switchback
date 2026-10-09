import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShellInfo } from '@switchback/protocol';
import { SwitchbackConfig } from '../config.ts';
import { privatePathMatcher, privateToolUse } from '../privacy.ts';
import { bashOutputTool, bashTool, killShellTool } from './bash.ts';
import { toolsFor } from './index.ts';
import { CommandRunner } from './process.ts';
import type { ToolContext } from './tool.ts';

const root = mkdtempSync(join(tmpdir(), 'switchback-shell-'));
afterEach(() => runner.close());

const changes: ShellInfo[] = [];
const runner = new CommandRunner(
  () => ({
    timeoutMs: 1_000,
    env: { GREETING: 'hello' },
    sandbox: SwitchbackConfig.parse({}).bash.sandbox,
  }),
  (s) => changes.push(s),
);
const ctx = (sessionId = 's1'): ToolContext => ({
  workspaceRoot: root,
  sessionId,
  signal: new AbortController().signal,
  agentCatalog: [],
  commands: runner,
});
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20);
};

describe('bash', () => {
  test('uses the configured environment and timeout', async () => {
    expect(await bashTool.run({ command: 'echo $GREETING' }, ctx())).toContain('hello');
    const started = Date.now();
    const slow = await bashTool.run({ command: 'sleep 5' }, ctx());
    expect(slow).toContain('timed out after 1s');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test('a child left running in the background never holds the call open', async () => {
    const started = Date.now();
    const out = await bashTool.run({ command: 'sleep 5 & echo done' }, ctx());
    expect(out).toContain('done');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test('a background shell keeps running; its output is read in pieces', async () => {
    const started = await bashTool.run(
      { command: 'echo one; sleep 0.2; echo two', background: true },
      ctx(),
    );
    const id = /sh_\w+/.exec(started as string)?.[0] as string;
    await until(() => runner.list().some((s) => s.id === id && s.status === 'exited'));
    const first = await bashOutputTool.run({ id }, ctx());
    expect(first).toStartWith('$ echo one; sleep 0.2; echo two');
    expect(first).toContain('exited with code 0');
    expect(first).toContain('one\ntwo');
    expect(await bashOutputTool.run({ id }, ctx())).toContain('(no new output)');
    expect(changes.filter((c) => c.id === id).map((c) => c.status)).toEqual(['running', 'exited']);
  });

  test('kill_shell stops it; other sessions can not see it', async () => {
    const started = await bashTool.run({ command: 'sleep 30', background: true }, ctx());
    const id = /sh_\w+/.exec(started as string)?.[0] as string;
    await expect(bashOutputTool.run({ id }, ctx('other'))).rejects.toThrow('no background shell');
    expect(await killShellTool.run({ id }, ctx())).toBe(`${id} stopped`);
    await until(() => changes.some((c) => c.id === id && c.status === 'killed'));
    expect(runner.list('s1').find((s) => s.id === id)?.status).toBe('killed');
  });

  test('an agent with bash gets its companions', () => {
    expect(toolsFor(['read', 'bash'], false).map((t) => t.name)).toEqual([
      'read',
      'bash',
      'bash_output',
      'kill_shell',
      'todo',
      'skill',
      'docs',
    ]);
    expect(toolsFor(['read'], false).map((t) => t.name)).toEqual(['read', 'todo', 'skill', 'docs']);
  });

  test("a background shell's output is private when its command names a private file", () => {
    const matches = privatePathMatcher(['secrets/**']) as (p: string) => boolean;
    const output = '$ tail -f secrets/app.log\n[sh_1: still running]\nline';
    expect(privateToolUse(matches, root, 'bash_output', { id: 'sh_1' }, output)).toContain(
      'secrets/app.log',
    );
  });
});

process.on('exit', () => rmSync(root, { recursive: true, force: true }));
