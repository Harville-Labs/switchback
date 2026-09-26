/**
 * Typed client for the engine protocol. The TUI, the VS Code extension, and
 * any third-party integration use this; none of them talk to providers or
 * tools directly.
 */
import {
  type EngineEvent,
  type InitializeResult,
  isNotification,
  isResponse,
  type JsonRpcMessage,
  type MethodName,
  type Methods,
  PROTOCOL_VERSION,
  RpcError,
  type Transport,
} from '@harness/protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export class HarnessClient {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private listeners = new Set<(event: EngineEvent) => void>();
  private closed = false;

  constructor(private readonly transport: Transport) {
    transport.onMessage((m) => this.handle(m));
    transport.onClose(() => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('engine connection closed'));
      this.pending.clear();
    });
  }

  async initialize(
    client: { name: string; version: string },
    workspaceRoot: string,
  ): Promise<InitializeResult> {
    return this.request('initialize', { protocolVersion: PROTOCOL_VERSION, client, workspaceRoot });
  }

  request<M extends MethodName>(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']> {
    if (this.closed) return Promise.reject(new Error('engine connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Subscribe to engine events. Returns an unsubscribe function. */
  on(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.transport.close();
  }

  private handle(m: JsonRpcMessage): void {
    if (isResponse(m)) {
      const p = m.id === null ? undefined : this.pending.get(m.id);
      if (!p || m.id === null) return;
      this.pending.delete(m.id);
      if ('error' in m) p.reject(new RpcError(m.error.code, m.error.message, m.error.data));
      else p.resolve(m.result);
    } else if (isNotification(m) && m.method === 'event') {
      for (const l of this.listeners) l(m.params as EngineEvent);
    }
  }
}
