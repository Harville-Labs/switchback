/**
 * End-to-end: the real CLI binary, spawned the same way the VS Code extension
 * spawns it, driven over stdio with the real client.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessClient, spawnEngine } from '@harness/client';
import type { EngineEvent } from '@harness/protocol';

const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const main = join(import.meta.dir, 'main.ts');

test('serve --stdio completes a turn for an out-of-process client', async () => {
  const transport = spawnEngine({
    command: process.execPath,
    args: [main, 'serve', '--stdio', '--mock'],
    cwd: join(import.meta.dir, '..', '..', '..'),
    env: { HARNESS_HOME: home },
  });
  const client = new HarnessClient(transport);
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
  expect(text).toBe('[mock anthropic] You said: ping');
  expect(events.find((e) => e.type === 'route.decided')).toMatchObject({
    tier: 'remote',
    rule: 'user-override',
  });
  await client.request('shutdown', {});
  client.close();
});

test('run exits non-zero with a clear message on bad flags', async () => {
  const proc = Bun.spawn([process.execPath, main, 'run', '--route', 'cloud', 'hi'], {
    env: { ...process.env, HARNESS_HOME: home },
    stderr: 'pipe',
  });
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stderr).text()).toContain('--route must be');
});
