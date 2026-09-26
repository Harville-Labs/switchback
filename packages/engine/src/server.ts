/**
 * Exposes an Engine over any Transport as a JSON-RPC 2.0 server. Engine events
 * are sent as `event` notifications.
 */
import {
  ErrorCode,
  EscalationRespondParams,
  encodeNdjson,
  InitializeParams,
  isRequest,
  type JsonRpcMessage,
  type JsonRpcRequest,
  NdjsonDecoder,
  PermissionRespondParams,
  PROTOCOL_VERSION,
  RpcError,
  SessionCancelParams,
  SessionCreateParams,
  SessionGetParams,
  SessionPromptParams,
  type Transport,
} from '@harness/protocol';
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

export function serve(engine: Engine, transport: Transport, onShutdown?: () => void): () => void {
  let initialized = false;
  const unsubscribe = engine.subscribe((event) => {
    if (initialized) transport.send({ jsonrpc: '2.0', method: 'event', params: event });
  });

  const dispatch = async (req: JsonRpcRequest): Promise<unknown> => {
    if (req.method !== 'initialize' && !initialized)
      throw new RpcError(ErrorCode.NotInitialized, 'call initialize first');
    switch (req.method) {
      case 'initialize': {
        const p = parse(InitializeParams, req.params);
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
      case 'session.cancel':
        return { cancelled: engine.cancel(parse(SessionCancelParams, req.params).sessionId) };
      case 'permission.respond': {
        const p = parse(PermissionRespondParams, req.params);
        engine.respondPermission(p.requestId, p.decision);
        return { ok: true };
      }
      case 'escalation.respond': {
        const p = parse(EscalationRespondParams, req.params);
        engine.respondEscalation(p.requestId, p.approve);
        return { ok: true };
      }
      case 'agents.list':
        return engine.listAgents();
      case 'usage.get':
        return engine.usage();
      case 'shutdown':
        await engine.shutdown();
        queueMicrotask(() => onShutdown?.());
        return { ok: true };
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `unknown method ${req.method}`);
    }
  };

  transport.onMessage((message: JsonRpcMessage) => {
    if (!isRequest(message)) return;
    dispatch(message).then(
      (result) => transport.send({ jsonrpc: '2.0', id: message.id, result: result ?? null }),
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
    void engine.shutdown();
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
    (line) => process.stderr.write(`harness: ignoring malformed input: ${line.slice(0, 200)}\n`),
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
