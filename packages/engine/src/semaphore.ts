export class Semaphore {
  private waiters: (() => void)[] = [];

  constructor(private available: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== grant);
        reject(signal?.reason ?? new Error('aborted'));
      };
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }
}
