/**
 * Shared engine daemon: one `switchback serve --socket` per workspace that the
 * TUI and VS Code both attach to, so they can share live sessions.
 *
 * Discovery: an info file (0600) in `<data>/daemons/` records the socket path,
 * a random token, the version, and the pid. Clients connect and present the
 * token in `initialize`. If there's no usable daemon, a client starts one.
 *
 * Versions: the newest Switchback wins, because the extension auto-updates while
 * the CLI updates separately. A client uses a daemon of its own version, or a
 * newer one that speaks the same protocol. It asks an older daemon to retire
 * (`daemon.retire`) and starts its own, unless someone else is still attached;
 * then it runs a private engine and says why.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type DaemonRetireResult,
  ErrorCode,
  encodeNdjson,
  type InitializeResult,
  type JsonRpcMessage,
  NdjsonDecoder,
  PROTOCOL_VERSION,
  RpcError,
  type Transport,
} from '@switchback/protocol';
import semver from 'semver';
import { SwitchbackClient } from './client.ts';

type Env = Record<string, string | undefined>;

export interface DaemonInfo {
  pid: number;
  socket: string;
  token: string;
  version: string;
  /** Absent in daemons from before version handover. */
  protocolVersion?: number;
  workspaceRoot: string;
}

/** Order two Switchback versions; undefined when either isn't SemVer. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  if (a === b) return 0;
  const [va, vb] = [semver.valid(a), semver.valid(b)];
  return va && vb ? semver.compare(va, vb) : undefined;
}

/** A client of `version` can use this daemon: the same version, or newer with the same protocol. */
export function canAttach(info: DaemonInfo, version: string): boolean {
  const order = compareVersions(info.version, version);
  return order === 0 || (order === 1 && info.protocolVersion === PROTOCOL_VERSION);
}

/** Mirrors switchbackPaths() in @switchback/engine (kept in sync by a test). */
export function dataDir(env: Env = process.env): string {
  return join(env.SWITCHBACK_HOME ?? join(homedir(), '.switchback'), 'data');
}

export function daemonPaths(workspaceRoot: string, env: Env = process.env) {
  const id = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  const dir = join(dataDir(env), 'daemons');
  // Unix socket paths are limited to ~104 bytes, so long data dirs fall back to tmp.
  const unixSocket = join(dir, `${id}.sock`);
  const socket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\switchback-${id}`
      : unixSocket.length < 100
        ? unixSocket
        : join('/tmp', `switchback-${process.getuid?.() ?? 'u'}-${id}.sock`);
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
  /** The version of the switchback that `spawn` runs (not necessarily the client's). */
  version: string;
  client: { name: string; version: string };
  /** How to start `switchback` if no daemon is running: argv[0] and leading args. */
  spawn: { command: string; args: string[] };
  env?: Env;
  startTimeoutMs?: number;
  log?: (message: string) => void;
}

/** Attached to the shared daemon, or not, with a reason to show the user. */
export type DaemonConnection =
  | { client: SwitchbackClient; init: InitializeResult; reason?: undefined }
  | { client?: undefined; init?: undefined; reason: string };

async function attach(info: DaemonInfo, o: ConnectDaemonOptions) {
  const transport = await socketTransport(info.socket);
  const client = new SwitchbackClient(transport);
  try {
    const init = await client.initialize(o.client, o.workspaceRoot, info.token);
    return { client, init };
  } catch (err) {
    client.close();
    throw err;
  }
}

/** Ask an older daemon to exit. Unreachable counts as gone. */
async function retire(info: DaemonInfo): Promise<DaemonRetireResult> {
  let transport: Transport;
  try {
    transport = await socketTransport(info.socket);
  } catch {
    return { retired: true };
  }
  const client = new SwitchbackClient(transport);
  try {
    return await client.request('daemon.retire', { token: info.token });
  } catch (err) {
    if (err instanceof RpcError && err.code === ErrorCode.MethodNotFound)
      return { retired: false, reason: "it's too old to hand over" };
    return { retired: false, reason: (err as Error).message };
  } finally {
    client.close();
  }
}

/**
 * Attach to this workspace's daemon, starting one if needed. Without a usable
 * daemon it returns a reason, and the caller runs its own engine.
 */
export async function connectDaemon(o: ConnectDaemonOptions): Promise<DaemonConnection> {
  const env = o.env ?? process.env;
  const existing = readDaemonInfo(o.workspaceRoot, env);
  if (existing && canAttach(existing, o.version)) {
    try {
      const attached = await attach(existing, o);
      if (existing.version !== o.version)
        o.log?.(`attached to the shared engine, which runs newer Switchback ${existing.version}`);
      return attached;
    } catch (err) {
      o.log?.(
        `daemon at ${existing.socket} unreachable (${(err as Error).message}); starting a new one`,
      );
    }
  } else if (existing) {
    const notShared = (why: string, fix: string) => ({
      reason: `Not sharing sessions with other windows: this workspace's shared engine runs Switchback ${existing.version}, ${why}. This window runs its own Switchback ${o.version} engine; ${fix}.`,
    });
    if (compareVersions(existing.version, o.version) !== -1)
      return notShared(
        "which this version can't connect to",
        'update Switchback here to share sessions again',
      );
    const outcome = await retire(existing);
    if (!outcome.retired)
      return notShared(
        `which is older and couldn't hand over (${outcome.reason ?? 'refused'})`,
        'sessions are shared again after the windows and terminals using it close',
      );
    o.log?.(`retired the shared engine running older Switchback ${existing.version}`);
    // It removes its info file before exiting; wait so the new daemon doesn't see it as live.
    const gone = Date.now() + 3000;
    while (readDaemonInfo(o.workspaceRoot, env)?.pid === existing.pid && Date.now() < gone)
      await new Promise((r) => setTimeout(r, 50));
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
    // Any usable daemon will do: another client may have won a start race.
    const info = readDaemonInfo(o.workspaceRoot, env);
    if (!info || !canAttach(info, o.version)) continue;
    try {
      return await attach(info, o);
    } catch {
      // Listening a moment after the info file appears; retry.
    }
  }
  return { reason: 'The shared engine did not start in time, so this window runs its own engine.' };
}
