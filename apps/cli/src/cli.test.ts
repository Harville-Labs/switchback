/**
 * End-to-end: the real CLI binary, spawned the same way the VS Code extension
 * spawns it, driven over stdio with the real client.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchbackClient, spawnEngine } from '@switchback/client';
import type { EngineEvent } from '@switchback/protocol';

const home = mkdtempSync(join(tmpdir(), 'switchback-home-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const main = join(import.meta.dir, 'main.ts');

test('serve --stdio completes a turn for an out-of-process client', async () => {
  const transport = spawnEngine({
    command: process.execPath,
    args: [main, 'serve', '--stdio', '--mock'],
    cwd: join(import.meta.dir, '..', '..', '..'),
    env: { SWITCHBACK_HOME: home },
  });
  const client = new SwitchbackClient(transport);
  const init = await client.initialize({ name: 'e2e', version: '0' }, process.cwd());
  expect(init.protocolVersion).toBe(1);

  const session = await client.request('session.create', {});
  const events: EngineEvent[] = [];
  const done = new Promise<void>((resolve) =>
    client.on((e) => {
      events.push(e);
      if (e.type === 'turn.completed') resolve();
    }),
  );
  await client.request('session.prompt', { sessionId: session.id, text: 'ping', route: 'remote' });
  await done;
  const text = events.flatMap((e) => (e.type === 'text.delta' ? [e.text] : [])).join('');
  expect(text).toBe('[mock mock-remote] You said: ping');
  expect(events.find((e) => e.type === 'route.decided')).toMatchObject({
    tier: 'remote',
    rule: 'user-override',
  });
  await client.request('shutdown', {});
  client.close();
});

test('run exits non-zero with a clear message on bad flags', async () => {
  const proc = Bun.spawn([process.execPath, main, 'run', '--route', 'cloud', 'hi'], {
    env: { ...process.env, SWITCHBACK_HOME: home },
    stderr: 'pipe',
  });
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain('--route must be');
});

test('agents new writes a valid file that a running engine picks up without a restart', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'switchback-agents-'));
  const transport = spawnEngine({
    command: process.execPath,
    args: [main, 'serve', '--stdio', '--mock', '--cwd', ws],
    // Not the workspace itself: Windows can't delete a directory a live process sits in.
    cwd: import.meta.dir,
    env: { SWITCHBACK_HOME: home },
  });
  const client = new SwitchbackClient(transport);
  await client.initialize({ name: 'e2e', version: '0' }, ws);
  expect((await client.request('agents.list', {})).map((a) => a.name)).not.toContain('reviewer');

  const made = Bun.spawnSync(
    [
      process.execPath,
      main,
      'agents',
      'new',
      '--yes',
      '--cwd',
      ws,
      '--name',
      'reviewer',
      '--description',
      'Reviews a diff for correctness bugs. Use after making changes.',
      '--tools',
      'read,grep,glob',
      '--model',
      'local',
      '--budget',
      '0.5',
      '--prompt',
      'You review diffs: look for bugs, report file:line.',
    ],
    { env: { ...process.env, SWITCHBACK_HOME: home }, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(made.exitCode).toBe(0);
  const file = readFileSync(join(ws, '.switchback', 'agents', 'reviewer.md'), 'utf8');
  expect(file).toContain('name: reviewer');
  expect(file).toContain('budgetUsd: 0.5');

  const listed = await client.request('agents.list', {});
  expect(listed.find((a) => a.name === 'reviewer')).toMatchObject({
    route: 'local',
    budgetUsd: 0.5,
    source: 'project',
  });
  // Usable immediately, including as a session agent.
  expect((await client.request('session.create', { agent: 'reviewer' })).agent).toBe('reviewer');

  const bad = Bun.spawnSync(
    [
      process.execPath,
      main,
      'agents',
      'new',
      '--yes',
      '--cwd',
      ws,
      '--name',
      'Bad Name',
      '--description',
      'x',
    ],
    { env: { ...process.env, SWITCHBACK_HOME: home }, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(bad.exitCode).toBe(2);
  expect(bad.stderr.toString()).toContain('lowercase');
  client.close();
  // Windows keeps the directory busy until the engine process has exited.
  rmSync(ws, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}, 30_000);

describe('switchback run for scripts', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'switchback-run-'));
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));
  const bash = 'mock:tool {"name":"bash","input":{"command":"echo hi"}}';
  const runCli = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, main, 'run', '--mock', '--cwd', workspace, ...args], {
      env: { ...process.env, SWITCHBACK_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };

  test('--output json prints one result object', async () => {
    const r = await runCli('--output', 'json', 'hello');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      result: '[mock mock-local] You said: hello',
      stopReason: 'end_turn',
      denied: false,
      exitCode: 0,
    });
  });

  test('a refused tool call exits 3; --deny refuses even with --yes', async () => {
    expect((await runCli(bash)).code).toBe(3);
    const r = await runCli('--yes', '--deny', 'bash', '--output', 'events', bash);
    expect(r.code).toBe(3);
    const completed = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as EngineEvent)
      .find((e) => e.type === 'tool.completed');
    expect(completed).toMatchObject({ denied: true });
  });

  test('a bad rule is a usage error', async () => {
    const r = await runCli('--deny', 'bash(', 'x');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('permission rule "bash("');
  });
});
