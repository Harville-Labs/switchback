/**
 * Shared engine daemon: one `harness serve --socket` per workspace that the
 * TUI and VS Code both attach to, so they can share live sessions.
 *
 * Discovery: an info file (0600) in `<data>/daemons/` records the socket path,
 * a random token, the version, and the pid. Clients connect and present the
 * token in `initialize`. If there's no usable daemon, a client starts one.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  encodeNdjson,
  type InitializeResult,
  type JsonRpcMessage,
  NdjsonDecoder,
  type Transport,
} from '@harness/protocol';
import { HarnessClient } from './client.ts';

type Env = Record<string, string | undefined>;

export interface DaemonInfo {
  pid: number;
  socket: string;
  token: string;
  version: string;
  workspaceRoot: string;
}

/** Mirrors harnessPaths() in @harness/engine (kept in sync by a test). */
export function dataDir(env: Env = process.env): string {
  if (env.HARNESS_HOME) return join(env.HARNESS_HOME, 'data');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'harness');
}

export function daemonPaths(workspaceRoot: string, env: Env = process.env) {
  const id = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  const dir = join(dataDir(env), 'daemons');
  // Unix socket paths are limited to ~104 bytes, so long data dirs fall back to tmp.
  const unixSocket = join(dir, `${id}.sock`);
  const socket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\harness-${id}`
      : unixSocket.length < 100
        ? unixSocket
        : join('/tmp', `harness-${process.getuid?.() ?? 'u'}-${id}.sock`);
  return { dir, info: join(dir, `${id}.json`), socket };
}

export function readDaemonInfo(
  workspaceRoot: string,
  env: Env = process.env,
): DaemonInfo | undefined {
  const { info } = daemonPaths(workspaceRoot, env);
  if (!existsSync(info)) return undefined;
  try {
    return JSON.parse(readFileSync(info, 'utf8')) as DaemonInfo;
  } catch {
    return undefined;
  }
}

/** NDJSON over a Unix socket or Windows named pipe. Rejects if nothing is listening. */
export function socketTransport(path: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const handlers: ((m: JsonRpcMessage) => void)[] = [];
    const closers: (() => void)[] = [];
    const decoder = new NdjsonDecoder((m) => {
      for (const h of handlers) h(m);
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const c of closers) c();
    };
    socket.once('connect', () => {
      socket.on('data', (chunk: Buffer) => decoder.push(new Uint8Array(chunk)));
      socket.on('close', close);
      resolve({
        send: (m) => {
          if (!closed) socket.write(encodeNdjson(m));
        },
        onMessage: (h) => handlers.push(h),
        onClose: (h) => closers.push(h),
        close: () => socket.end(),
      });
    });
    socket.once('error', (err) => {
      if (closed) return;
      closed = true;
      reject(err);
    });
  });
}

export interface ConnectDaemonOptions {
  workspaceRoot: string;
  /** This client's harness version; a daemon of another version is not used. */
  version: string;
  client: { name: string; version: string };
  /** How to start `harness` if no daemon is running: argv[0] and leading args. */
  spawn: { command: string; args: string[] };
  env?: Env;
  startTimeoutMs?: number;
  log?: (message: string) => void;
}

async function attach(info: DaemonInfo, o: ConnectDaemonOptions) {
  const transport = await socketTransport(info.socket);
  const client = new HarnessClient(transport);
  try {
    const init = await client.initialize(o.client, o.workspaceRoot, info.token);
    return { client, init };
  } catch (err) {
    client.close();
    throw err;
  }
}

/**
 * Attach to this workspace's daemon, starting one if needed. Returns undefined
 * when no compatible daemon can be reached; the caller then runs its own engine.
 */
export async function connectDaemon(
  o: ConnectDaemonOptions,
): Promise<{ client: HarnessClient; init: InitializeResult } | undefined> {
  const env = o.env ?? process.env;
  const existing = readDaemonInfo(o.workspaceRoot, env);
  if (existing) {
    if (existing.version !== o.version) {
      o.log?.(`daemon is version ${existing.version}, not ${o.version}; using a private engine`);
      return undefined;
    }
    try {
      return await attach(existing, o);
    } catch (err) {
      o.log?.(
        `daemon at ${existing.socket} unreachable (${(err as Error).message}); starting a new one`,
      );
    }
  }
  const child = spawn(o.spawn.command, [...o.spawn.args, 'serve', '--socket'], {
    cwd: o.workspaceRoot,
    env: { ...process.env, ...env },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => o.log?.(`could not start daemon: ${err.message}`));
  child.unref();
  const deadline = Date.now() + (o.startTimeoutMs ?? 8000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    // Any compatible daemon will do: another client may have won a start race.
    const info = readDaemonInfo(o.workspaceRoot, env);
    if (!info || info.version !== o.version) continue;
    try {
      return await attach(info, o);
    } catch {
      // Listening a moment after the info file appears; retry.
    }
  }
  o.log?.('daemon did not start in time; using a private engine');
  return undefined;
}
