/**
 * `switchback serve --stdio`: expose the engine over stdin/stdout for one client
 * (the VS Code extension's private engine, or any integration). stdout carries
 * protocol messages only; everything else goes to stderr.
 *
 * `switchback serve --socket`: the shared daemon for this workspace. Many clients
 * (TUI, VS Code) attach and share live sessions. It exits after being idle.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { type DaemonInfo, daemonPaths, readDaemonInfo, socketTransport } from '@switchback/client';
import { listenSocket, serve as serveEngine, stdioTransport } from '@switchback/engine';
import {
  CLI_VERSION,
  type CommonFlags,
  createEngine,
  refreshOrgPolicyQuickly,
} from '../bootstrap.ts';

export async function serve(flags: CommonFlags & { socket?: boolean }): Promise<number> {
  await refreshOrgPolicyQuickly();
  if (flags.socket) return serveSocket(flags);
  const { engine, agentErrors } = createEngine(flags, 'prompt', { syncOrg: true, telemetry: true });
  for (const e of agentErrors) process.stderr.write(`switchback: agent definition skipped: ${e}\n`);
  const transport = stdioTransport();
  return new Promise((resolve) => {
    serveEngine(engine, transport, () => resolve(0));
    transport.onClose(() => resolve(0));
  });
}

const IDLE_MS = Number(process.env.SWITCHBACK_DAEMON_IDLE_MS) || 10 * 60_000;

async function serveSocket(flags: CommonFlags): Promise<number> {
  const paths = daemonPaths(flags.cwd);
  const existing = readDaemonInfo(flags.cwd);
  if (existing) {
    // Another live daemon already serves this workspace: leave it alone.
    const alive = await socketTransport(existing.socket).then(
      (t) => {
        t.close();
        return true;
      },
      () => false,
    );
    if (alive) {
      process.stderr.write(`switchback: a daemon is already running for ${flags.cwd}\n`);
      return 0;
    }
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(paths.dir, 0o700);
  } catch {
    // Windows: named pipe + token instead.
  }
  if (process.platform !== 'win32') rmSync(paths.socket, { force: true }); // stale socket from a crash

  const { engine, agentErrors } = createEngine(flags, 'prompt', { syncOrg: true, telemetry: true });
  for (const e of agentErrors) process.stderr.write(`switchback: agent definition skipped: ${e}\n`);

  const token = randomBytes(24).toString('hex');
  let connections = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let server: { close: () => void } | undefined;

  const cleanup = () => {
    server?.close();
    // Only remove files that are still ours.
    if (readDaemonInfo(flags.cwd)?.pid === process.pid) rmSync(paths.info, { force: true });
    if (process.platform !== 'win32') rmSync(paths.socket, { force: true });
  };
  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function check() {
      if (connections > 0) return;
      if (engine.busy()) {
        idleTimer = setTimeout(check, 30_000); // finish running turns first
        return;
      }
      cleanup();
      process.exit(0);
    }, IDLE_MS);
  };

  server = await listenSocket(engine, paths.socket, {
    token,
    onConnections: (n) => {
      connections = n;
      if (n === 0) scheduleIdle();
      else if (idleTimer) clearTimeout(idleTimer);
    },
  });
  if (process.platform !== 'win32') chmodSync(paths.socket, 0o600);
  const info: DaemonInfo = {
    pid: process.pid,
    socket: paths.socket,
    token,
    version: CLI_VERSION,
    workspaceRoot: flags.cwd,
  };
  writeFileSync(paths.info, JSON.stringify(info), { mode: 0o600 });
  scheduleIdle();

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
  return new Promise(() => {}); // runs until idle or signalled
}
