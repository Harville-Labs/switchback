/**
 * End-to-end: two clients share one `switchback serve --socket` daemon, backed by
 * a fake OpenAI-compatible local server (daemons never run in --mock mode).
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectDaemon,
  type DaemonInfo,
  daemonPaths,
  readDaemonInfo,
  SwitchbackClient,
  socketTransport,
} from '@switchback/client';
import {
  type EngineEvent,
  ErrorCode,
  encodeNdjson,
  isRequest,
  type JsonRpcMessage,
  NdjsonDecoder,
  PROTOCOL_VERSION,
} from '@switchback/protocol';
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
  // Windows holds a directory while a daemon still runs in it; give stragglers a moment.
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

test('two clients share one daemon and see each other’s live turns', async () => {
  const a = await connectDaemon(options('a'));
  const b = await connectDaemon(options('b'));
  if (!a.client || !b.client) throw new Error(a.reason ?? b.reason);
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

/**
 * A stand-in for another version's daemon: answers `daemon.retire` as told (or
 * not at all, like daemons from before handover) and refuses everything else.
 */
function fakeDaemon(
  ws: string,
  info: { version: string; protocolVersion?: number },
  retire?: { retired: boolean; reason?: string },
) {
  const { dir, info: infoPath, socket } = daemonPaths(ws, env);
  mkdirSync(dir, { recursive: true });
  if (process.platform !== 'win32') rmSync(socket, { force: true });
  const server = createServer((conn) => {
    const decoder = new NdjsonDecoder((m) => {
      if (!isRequest(m)) return;
      const reply = (body: object) =>
        conn.write(encodeNdjson({ jsonrpc: '2.0', id: m.id, ...body } as JsonRpcMessage));
      if (m.method === 'daemon.retire' && retire) {
        reply({ result: retire });
        if (retire.retired) {
          rmSync(infoPath, { force: true });
          server.close();
        }
      } else
        reply({ error: { code: ErrorCode.MethodNotFound, message: `unknown method ${m.method}` } });
    });
    conn.on('data', (chunk: Buffer) => decoder.push(new Uint8Array(chunk)));
    conn.on('error', () => conn.destroy());
  });
  server.listen(socket);
  writeFileSync(
    infoPath,
    JSON.stringify({ pid: 1, socket, token: 't', workspaceRoot: ws, ...info } satisfies DaemonInfo),
  );
  return { close: () => server.close(), infoPath };
}

const freshWorkspace = (name: string) => {
  const ws = join(base, name);
  mkdirSync(ws, { recursive: true });
  return ws;
};

test('a newer client retires an idle older daemon and starts its own', async () => {
  const ws = freshWorkspace('handover');
  const old = fakeDaemon(
    ws,
    { version: '0.0.1', protocolVersion: PROTOCOL_VERSION },
    { retired: true },
  );
  const logs: string[] = [];
  const c = await connectDaemon({ ...options('new'), workspaceRoot: ws, log: (m) => logs.push(m) });
  old.close();
  if (!c.client) throw new Error(c.reason);
  expect(readDaemonInfo(ws, env)?.version).toBe(CLI_VERSION);
  expect(logs.join('\n')).toContain('retired the shared engine running older Switchback 0.0.1');
  // Stop the daemon this test started, so it isn't left running in the workspace.
  const started = readDaemonInfo(ws, env);
  await c.client.request('daemon.retire', { token: started?.token ?? '' });
  c.client.close();
  const deadline = Date.now() + 3000;
  while (readDaemonInfo(ws, env) && Date.now() < deadline) await Bun.sleep(50);
}, 20_000);

test('an older daemon that is in use, or too old to ask, is left alone with a reason', async () => {
  for (const [name, retire, expected] of [
    ['busy', { retired: false, reason: 'a turn is running' }, 'a turn is running'],
    ['ancient', undefined, 'too old to hand over'],
  ] as const) {
    const ws = freshWorkspace(name);
    const old = fakeDaemon(ws, { version: '0.0.1' }, retire);
    const c = await connectDaemon({ ...options(name), workspaceRoot: ws });
    old.close();
    expect(c.client).toBeUndefined();
    expect(c.reason).toContain('Switchback 0.0.1');
    expect(c.reason).toContain(expected);
    // Still the old daemon's: nothing new was started.
    expect(readDaemonInfo(ws, env)?.version).toBe('0.0.1');
  }
});

test('a newer daemon on another protocol is not used, and says to update', async () => {
  const ws = freshWorkspace('future');
  const future = fakeDaemon(ws, { version: '99.0.0', protocolVersion: PROTOCOL_VERSION + 1 });
  const c = await connectDaemon({ ...options('old'), workspaceRoot: ws });
  future.close();
  expect(c.client).toBeUndefined();
  expect(c.reason).toContain("can't connect");
  expect(c.reason).toContain('update Switchback');
});

test('an older client attaches to a newer daemon that speaks its protocol', async () => {
  const ws = freshWorkspace('older-client');
  const first = await connectDaemon({ ...options('first'), workspaceRoot: ws });
  if (!first.client) throw new Error(first.reason);
  const logs: string[] = [];
  const older = await connectDaemon({
    ...options('older'),
    workspaceRoot: ws,
    version: '0.0.1',
    log: (m) => logs.push(m),
  });
  if (!older.client) throw new Error(older.reason);
  expect(older.init.engineVersion).toBe(CLI_VERSION);
  expect(logs.join('\n')).toContain('newer Switchback');

  // The real daemon refuses to retire while another client is attached...
  const info = readDaemonInfo(ws, env);
  expect(await older.client.request('daemon.retire', { token: info?.token ?? '' })).toEqual({
    retired: false,
    reason: 'another window or terminal is attached',
  });
  first.client.close();
  await Bun.sleep(100);
  // ...and steps aside once it's the only one, removing its info file.
  expect(await older.client.request('daemon.retire', { token: info?.token ?? '' })).toEqual({
    retired: true,
  });
  older.client.close();
  const deadline = Date.now() + 3000;
  while (readDaemonInfo(ws, env) && Date.now() < deadline) await Bun.sleep(50);
  expect(readDaemonInfo(ws, env)).toBeUndefined();
}, 20_000);
