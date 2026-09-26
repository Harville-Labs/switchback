import type { JsonRpcMessage } from './jsonrpc.ts';

/** A bidirectional message channel. Implementations: stdio, child process, in-memory pair. */
export interface Transport {
  send(message: JsonRpcMessage): void;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/** Splits an NDJSON byte stream into parsed messages. Malformed lines are reported, not thrown. */
export class NdjsonDecoder {
  private buffer = '';
  private decoder = new TextDecoder();

  constructor(
    private readonly onMessage: (m: JsonRpcMessage) => void,
    private readonly onError: (line: string, err: unknown) => void = () => {},
  ) {}

  push(chunk: Uint8Array | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) {
        try {
          this.onMessage(JSON.parse(line) as JsonRpcMessage);
        } catch (err) {
          this.onError(line, err);
        }
      }
      nl = this.buffer.indexOf('\n');
    }
  }
}

export function encodeNdjson(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Two connected in-memory transports. Used to run the engine in-process (the
 * TUI's default) while still going through the exact same protocol as an
 * out-of-process client. Messages are JSON round-tripped so nothing that would
 * fail over a real wire can sneak through.
 */
export function createTransportPair(): [Transport, Transport] {
  const make = () => {
    const handlers: ((m: JsonRpcMessage) => void)[] = [];
    const closers: (() => void)[] = [];
    return { handlers, closers };
  };
  const a = make();
  const b = make();
  let closed = false;
  const side = (self: ReturnType<typeof make>, peer: ReturnType<typeof make>): Transport => ({
    send(message) {
      if (closed) return;
      const copy = JSON.parse(JSON.stringify(message)) as JsonRpcMessage;
      queueMicrotask(() => {
        for (const h of peer.handlers) h(copy);
      });
    },
    onMessage(handler) {
      self.handlers.push(handler);
    },
    onClose(handler) {
      self.closers.push(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const c of [...a.closers, ...b.closers]) c();
    },
  });
  return [side(a, b), side(b, a)];
}
