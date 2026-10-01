/**
 * End-to-end: two clients share one `switchback serve --socket` daemon, backed by
 * a fake OpenAI-compatible local server (daemons never run in --mock mode).
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectDaemon,
  daemonPaths,
  readDaemonInfo,
  SwitchbackClient,
  socketTransport,
} from '@switchback/client';
import type { EngineEvent } from '@switchback/protocol';
import { CLI_VERSION } from './bootstrap.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'switchback-daemon-')));
const home = join(base, 'home');
const workspace = join(base, 'ws');
mkdirSync(home, { recursive: true });
mkdirSync(workspace, { recursive: true });

// A slow fake model, so one client can watch another's turn in progress.
const model = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'fake' }] });
    const stream = new ReadableStream({
      async start(c) {
        for (const word of ['shared ', 'engine ', 'works']) {
          c.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`,
            ),
          );
          await Bun.sleep(150);
        }
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          ),
        );
        c.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  },
});
writeFileSync(
  join(home, 'config.json'),
  JSON.stringify({
    providers: {
      fake: { type: 'openai-compatible', baseUrl: `http://localhost:${model.port}/v1` },
    },
    models: { local: { provider: 'fake', model: 'fake', contextWindow: 32768 } },
    routing: { mode: 'local-only' },
  }),
);

const env = { SWITCHBACK_HOME: home, SWITCHBACK_DAEMON_IDLE_MS: '1500' };
const main = join(import.meta.dir, 'main.ts');
const options = (name: string) => ({
  workspaceRoot: workspace,
  version: CLI_VERSION,
  client: { name, version: '0' },
  spawn: { command: process.execPath, args: [main] },
  env,
});

afterAll(() => {
  model.stop(true);
  rmSync(base, { recursive: true, force: true });
});

test('two clients share one daemon and see each other’s live turns', async () => {
  const a = await connectDaemon(options('a'));
  const b = await connectDaemon(options('b'));
  if (!a || !b) throw new Error('daemon unavailable');
  const info = readDaemonInfo(workspace, env);
  expect(info?.version).toBe(CLI_VERSION);
  if (process.platform !== 'win32') {
    expect(statSync(daemonPaths(workspace, env).info).mode & 0o077).toBe(0);
  }

  const seenByB: EngineEvent[] = [];
  b.client.on((e) => seenByB.push(e));
  const session = await a.client.request('session.create', {});
  await a.client.request('session.prompt', { sessionId: session.id, text: 'hi' });
  await Bun.sleep(200);

  // B finds A's session running and gets its streamed output.
  const listed = await b.client.request('session.list', {});
  expect(listed.find((s) => s.id === session.id)?.running).toBe(true);
  const done = new Promise<void>((resolve) =>
    b.client.on((e) => {
      if (e.type === 'turn.completed' && e.sessionId === session.id) resolve();
    }),
  );
  await done;
  const text = seenByB
    .flatMap((e) => (e.type === 'text.delta' && e.sessionId === session.id ? [e.text] : []))
    .join('');
  expect(text.length).toBeGreaterThan(0);

  // A wrong token is refused.
  const intruder = new SwitchbackClient(await socketTransport(info?.socket ?? ''));
  await expect(intruder.initialize({ name: 'x', version: '0' }, workspace, 'nope')).rejects.toThrow(
    'invalid daemon token',
  );
  intruder.close();

  // A client leaving (even calling shutdown) doesn't stop the daemon for others.
  await a.client.request('shutdown', {});
  a.client.close();
  expect((await b.client.request('session.get', { sessionId: session.id })).messages).toHaveLength(
    2,
  );
  b.client.close();

  // With no clients it exits after the idle timeout and cleans up.
  const deadline = Date.now() + 8000;
  while (readDaemonInfo(workspace, env) && Date.now() < deadline) await Bun.sleep(100);
  expect(readDaemonInfo(workspace, env)).toBeUndefined();
}, 30_000);
