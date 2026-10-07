/**
 * Exposes an Engine over any Transport as a JSON-RPC 2.0 server. Engine events
 * are sent as `event` notifications.
 */

import { createServer } from 'node:net';
import {
  DaemonRetireParams,
  type DaemonRetireResult,
  ErrorCode,
  EscalationRespondParams,
  encodeNdjson,
  InitializeParams,
  isRequest,
  type JsonRpcMessage,
  type JsonRpcRequest,
  NdjsonDecoder,
  PermissionRespondParams,
  PermissionsListParams,
  PROTOCOL_VERSION,
  RpcError,
  SessionCancelParams,
  SessionCheckpointsParams,
  SessionCompactParams,
  SessionCreateParams,
  SessionDequeueParams,
  SessionEscalateParams,
  SessionGetParams,
  SessionPromptParams,
  SessionRewindParams,
  SessionRolesParams,
  SessionSetModeParams,
  SessionSetRolesParams,
  ShellsKillParams,
  ShellsListParams,
  type Transport,
  UsageGetParams,
} from '@switchback/protocol';
import type { z } from 'zod';
import type { Engine } from './engine.ts';

function parse<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const r = schema.safeParse(params ?? {});
  if (!r.success) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return r.data;
}

export interface ServeOptions {
  /** Require this token in `initialize` (shared daemons). */
  token?: string;
  /**
   * Stop the engine's turns when this connection closes or calls `shutdown`.
   * True for a client's private engine; false for a shared daemon, where one
   * client leaving must not affect the others.
   */
  ownsEngine?: boolean;
  /** Shared daemons: whether to exit for a newer Switchback (`daemon.retire`). */
  retire?: () => DaemonRetireResult;
  /** Called after a successful `daemon.retire` reply has been sent. */
  onRetired?: () => void;
}

export function serve(
  engine: Engine,
  transport: Transport,
  onShutdown?: () => void,
  options: ServeOptions = {},
): () => void {
  const ownsEngine = options.ownsEngine ?? true;
  let initialized = false;
  const unsubscribe = engine.subscribe((event) => {
    if (initialized) transport.send({ jsonrpc: '2.0', method: 'event', params: event });
  });

  const dispatch = async (req: JsonRpcRequest): Promise<unknown> => {
    // Before the initialize check: a newer client may speak another protocol version.
    if (req.method === 'daemon.retire') {
      const p = parse(DaemonRetireParams, req.params);
      if (!options.token || !options.retire)
        return { retired: false, reason: 'not a shared engine' } satisfies DaemonRetireResult;
      if (p.token !== options.token)
        throw new RpcError(ErrorCode.Unauthorized, 'invalid daemon token');
      return options.retire();
    }
    if (req.method !== 'initialize' && !initialized)
      throw new RpcError(ErrorCode.NotInitialized, 'call initialize first');
    switch (req.method) {
      case 'initialize': {
        const p = parse(InitializeParams, req.params);
        if (options.token && p.token !== options.token)
          throw new RpcError(ErrorCode.Unauthorized, 'invalid daemon token');
        if (p.protocolVersion !== PROTOCOL_VERSION)
          throw new RpcError(
            ErrorCode.InvalidRequest,
            `protocol version mismatch: client ${p.protocolVersion}, engine ${PROTOCOL_VERSION}`,
          );
        initialized = true;
        return engine.initialize();
      }
      case 'session.create':
        return engine.createSession(parse(SessionCreateParams, req.params));
      case 'session.list':
        return engine.listSessions();
      case 'session.get':
        return engine.getSession(parse(SessionGetParams, req.params).sessionId);
      case 'session.prompt':
        return engine.prompt(parse(SessionPromptParams, req.params));
      case 'session.roles':
        return engine.roles(parse(SessionRolesParams, req.params).sessionId);
      case 'session.setRoles':
        return engine.setRoles(parse(SessionSetRolesParams, req.params));
      case 'session.compact':
        return engine.compactSession(parse(SessionCompactParams, req.params).sessionId);
      case 'session.checkpoints':
        return engine.listCheckpoints(parse(SessionCheckpointsParams, req.params).sessionId);
      case 'session.rewind':
        return engine.rewind(parse(SessionRewindParams, req.params));
      case 'session.dequeue': {
        const p = parse(SessionDequeueParams, req.params);
        return engine.dequeue(p.sessionId, p.id);
      }
      case 'session.cancel':
        return { cancelled: engine.cancel(parse(SessionCancelParams, req.params).sessionId) };
      case 'permission.respond': {
        const p = parse(PermissionRespondParams, req.params);
        engine.respondPermission(p.requestId, p.decision, p.save);
        return { ok: true };
      }
      case 'session.escalate':
        return engine.escalate(parse(SessionEscalateParams, req.params).sessionId);
      case 'session.setMode': {
        const p = parse(SessionSetModeParams, req.params);
        return engine.setMode(p.sessionId, p.mode);
      }
      case 'shells.list':
        return engine.shells(parse(ShellsListParams, req.params).sessionId);
      case 'shells.kill':
        return engine.killShell(parse(ShellsKillParams, req.params).shellId);
      case 'permissions.list':
        return engine.permissions(parse(PermissionsListParams, req.params).sessionId);
      case 'escalation.respond': {
        const p = parse(EscalationRespondParams, req.params);
        engine.respondEscalation(p.requestId, p.approve);
        return { ok: true };
      }
      case 'mcp.list':
        return engine.mcpStatus();
      case 'agents.list':
        return engine.listAgents();
      case 'commands.list':
        return engine.listCommands();
      case 'usage.get': {
        const p = parse(UsageGetParams, req.params);
        return engine.usage(p.period, p.sessionId);
      }
      case 'shutdown':
        // onShutdown runs after the reply is sent (see below).
        if (ownsEngine) await engine.shutdown();
        return { ok: true };
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `unknown method ${req.method}`);
    }
  };

  transport.onMessage((message: JsonRpcMessage) => {
    if (!isRequest(message)) return;
    dispatch(message).then(
      (result) => {
        transport.send({ jsonrpc: '2.0', id: message.id, result: result ?? null });
        // Close only after the reply is written, or the client never sees it.
        if (message.method === 'shutdown') onShutdown?.();
        if (message.method === 'daemon.retire' && (result as DaemonRetireResult).retired)
          options.onRetired?.();
      },
      (err: unknown) => {
        const rpc = err instanceof RpcError ? err : undefined;
        transport.send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: rpc?.code ?? ErrorCode.InternalError,
            message: (err as Error)?.message ?? String(err),
            ...(rpc?.data !== undefined ? { data: rpc.data } : {}),
          },
        });
      },
    );
  });
  transport.onClose(() => {
    unsubscribe();
    if (ownsEngine) void engine.shutdown();
  });
  return unsubscribe;
}

/** Transport over this process's stdin/stdout. Diagnostics must go to stderr. */
export function stdioTransport(): Transport {
  const handlers: ((m: JsonRpcMessage) => void)[] = [];
  const closers: (() => void)[] = [];
  const decoder = new NdjsonDecoder(
    (m) => {
      for (const h of handlers) h(m);
    },
    (line) => process.stderr.write(`switchback: ignoring malformed input: ${line.slice(0, 200)}\n`),
  );
  process.stdin.on('data', (chunk: Buffer) => decoder.push(chunk));
  process.stdin.on('end', () => {
    for (const c of closers) c();
  });
  return {
    send: (m) => {
      process.stdout.write(encodeNdjson(m));
    },
    onMessage: (h) => handlers.push(h),
    onClose: (h) => closers.push(h),
    close: () => process.stdin.destroy(),
  };
}

/**
 * Accept many clients on a Unix socket / named pipe (a shared daemon).
 * Returns a close function; `onConnections` reports the live connection count.
 */
export function listenSocket(
  engine: Engine,
  path: string,
  options: {
    token: string;
    onConnections?: (count: number) => void;
    retire?: ServeOptions['retire'];
    onRetired?: ServeOptions['onRetired'];
  },
): Promise<{ close: () => void }> {
  let count = 0;
  const server = createServer((socket) => {
    count++;
    options.onConnections?.(count);
    const handlers: ((m: JsonRpcMessage) => void)[] = [];
    const closers: (() => void)[] = [];
    const decoder = new NdjsonDecoder((m) => {
      for (const h of handlers) h(m);
    });
    socket.on('data', (chunk: Buffer) => decoder.push(new Uint8Array(chunk)));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      count--;
      options.onConnections?.(count);
      for (const c of closers) c();
    });
    const transport: Transport = {
      send: (m) => {
        if (!socket.destroyed) socket.write(encodeNdjson(m));
      },
      onMessage: (h) => handlers.push(h),
      onClose: (h) => closers.push(h),
      close: () => socket.end(),
    };
    serve(engine, transport, () => socket.end(), {
      token: options.token,
      ownsEngine: false,
      retire: options.retire,
      onRetired: options.onRetired,
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve({ close: () => server.close() }));
  });
}
