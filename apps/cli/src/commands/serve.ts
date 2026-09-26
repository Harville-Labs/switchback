/**
 * `harness serve --stdio`: expose the engine over stdin/stdout. This is how the
 * VS Code extension (and any other out-of-process client) talks to harness.
 * stdout carries protocol messages only; everything else goes to stderr.
 */
import { serve as serveEngine, stdioTransport } from '@harness/engine';
import { type CommonFlags, createEngine } from '../bootstrap.ts';

export async function serve(flags: CommonFlags): Promise<number> {
  const { engine, agentErrors } = createEngine(flags, 'prompt');
  for (const e of agentErrors) process.stderr.write(`harness: agent definition skipped: ${e}\n`);
  const transport = stdioTransport();
  return new Promise((resolve) => {
    serveEngine(engine, transport, () => resolve(0));
    transport.onClose(() => resolve(0));
  });
}
