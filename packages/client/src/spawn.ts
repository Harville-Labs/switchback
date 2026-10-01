import { spawn } from 'node:child_process';
import {
  encodeNdjson,
  type JsonRpcMessage,
  NdjsonDecoder,
  type Transport,
} from '@switchback/protocol';

export interface SpawnOptions {
  /** Path to the `switchback` executable. */
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Receives the engine's stderr (logs, diagnostics). */
  onStderr?: (text: string) => void;
}

/**
 * Start `switchback serve --stdio` as a child process and talk to it over its
 * stdin/stdout. Uses node:child_process so it runs inside VS Code's extension
 * host as well as under Bun.
 */
export function spawnEngine(options: SpawnOptions): Transport {
  const child = spawn(options.command, options.args ?? ['serve', '--stdio'], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const handlers: ((m: JsonRpcMessage) => void)[] = [];
  const closers: (() => void)[] = [];
  const decoder = new NdjsonDecoder((m) => {
    for (const h of handlers) h(m);
  });
  child.stdout.on('data', (chunk: Buffer) => decoder.push(new Uint8Array(chunk)));
  child.stderr.on('data', (chunk: Buffer) => options.onStderr?.(chunk.toString()));
  let closed = false;
  const fireClose = () => {
    if (closed) return;
    closed = true;
    for (const c of closers) c();
  };
  child.on('exit', fireClose);
  child.on('error', (err) => {
    options.onStderr?.(`failed to start ${options.command}: ${err.message}\n`);
    fireClose();
  });
  return {
    send: (m) => {
      if (!closed) child.stdin.write(encodeNdjson(m));
    },
    onMessage: (h) => handlers.push(h),
    onClose: (h) => closers.push(h),
    close: () => {
      child.stdin.end();
      setTimeout(() => child.kill(), 2000).unref();
    },
  };
}
