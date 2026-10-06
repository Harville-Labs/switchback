import { ErrorCode, RpcError } from '@switchback/protocol';

/**
 * Questions waiting for a client's answer (permission and escalation prompts),
 * by request ID. Cancelling the turn answers with the abort value.
 */
export class PendingPrompts<T> {
  private pending = new Map<string, (answer: T) => void>();

  constructor(private readonly kind: string) {}

  ask(requestId: string, signal: AbortSignal, onAbort: T, announce: () => void): Promise<T> {
    return new Promise<T>((resolve) => {
      const abort = () => {
        this.pending.delete(requestId);
        resolve(onAbort);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(requestId, (answer) => {
        signal.removeEventListener('abort', abort);
        resolve(answer);
      });
      announce();
    });
  }

  answer(requestId: string, answer: T): void {
    const resolve = this.pending.get(requestId);
    if (!resolve)
      throw new RpcError(ErrorCode.InvalidParams, `no pending ${this.kind} ${requestId}`);
    this.pending.delete(requestId);
    resolve(answer);
  }
}
