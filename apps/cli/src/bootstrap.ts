import { HarnessClient } from '@harness/client';
import { ConfigError, Engine, type EngineOptions, loadConfig, serve } from '@harness/engine';
import { createTransportPair } from '@harness/protocol';
import pkg from '../package.json' with { type: 'json' };

export const CLI_VERSION = pkg.version;

export interface CommonFlags {
  cwd: string;
  mock: boolean;
}

/** Replace every provider with the scripted mock, for demos and UI work with no model running. */
const MOCK_LAYER = {
  providers: {
    ollama: { type: 'mock', tier: 'local' },
    anthropic: { type: 'mock', tier: 'remote' },
  },
};

export function createEngine(flags: CommonFlags, interaction: EngineOptions['interaction']) {
  try {
    const loaded = loadConfig(flags.cwd, process.env, flags.mock ? [MOCK_LAYER] : []);
    const { engine, agentErrors } = Engine.fromWorkspace(flags.cwd, loaded.config, {
      prices: loaded.prices,
      ...(interaction ? { interaction } : {}),
    });
    return { engine, loaded, agentErrors };
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`harness: ${err.file ? `${err.file}: ` : ''}${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}

/**
 * Run the engine in-process but talk to it through the protocol, exactly as
 * an out-of-process client would. There is no private fast path.
 */
export async function connectInProcess(
  flags: CommonFlags,
  interaction: EngineOptions['interaction'],
  clientName: string,
) {
  const { engine, agentErrors } = createEngine(flags, interaction);
  const [serverSide, clientSide] = createTransportPair();
  serve(engine, serverSide);
  const client = new HarnessClient(clientSide);
  const init = await client.initialize({ name: clientName, version: CLI_VERSION }, flags.cwd);
  return { client, init, agentErrors };
}
