/**
 * `switchback acp`: Switchback as an Agent Client Protocol agent over
 * stdin/stdout, for editors that launch ACP agents (docs/clients/acp.md).
 * Each workspace the editor opens attaches to that workspace's shared engine,
 * like the TUI, or runs a private one. stdout carries ACP messages only.
 */
import { Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { AcpBridge } from '../acp/bridge.ts';
import { CLI_VERSION, type CommonFlags, connectShared } from '../bootstrap.ts';

export async function acpServer(flags: CommonFlags & { daemon: boolean }): Promise<number> {
  const bridge = new AcpBridge({
    version: CLI_VERSION,
    async connect(cwd) {
      const { client, warnings } = await connectShared({ ...flags, cwd }, 'switchback-acp');
      for (const w of warnings) process.stderr.write(`switchback acp: ${w}\n`);
      return client;
    },
  });
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Bun.stdin.stream(),
  );
  await bridge.app().connect(stream).closed;
  return 0;
}
