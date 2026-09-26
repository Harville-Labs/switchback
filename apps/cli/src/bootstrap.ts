import { HarnessClient } from '@harness/client';
import {
  ConfigError,
  Engine,
  type EngineOptions,
  type HarnessConfig,
  loadConfig,
  serve,
} from '@harness/engine';
import { createTransportPair } from '@harness/protocol';
import { tierOf } from '@harness/providers';
import pkg from '../package.json' with { type: 'json' };

export const CLI_VERSION = pkg.version;

export interface CommonFlags {
  cwd: string;
  mock: boolean;
}

/**
 * Swap every configured provider for the scripted mock (keeping its tier) and
 * add a mock local model if none is configured, for demos and UI work with no
 * model running.
 */
export function mockify(config: HarnessConfig): HarnessConfig {
  const providers: HarnessConfig['providers'] = {};
  for (const [id, pc] of Object.entries(config.providers))
    providers[id] = { type: 'mock', tier: tierOf(pc) };
  const models = { ...config.models };
  if (!models[config.routing.local]) {
    providers['mock-local'] = { type: 'mock', tier: 'local' };
    models[config.routing.local] = {
      provider: 'mock-local',
      model: 'mock-local',
      contextWindow: 32_768,
      maxOutputTokens: 16_000,
    };
  }
  return { ...config, providers, models };
}

export function createEngine(flags: CommonFlags, interaction: EngineOptions['interaction']) {
  try {
    const loaded = loadConfig(flags.cwd, process.env);
    if (flags.mock) loaded.config = mockify(loaded.config);
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

/** True on a machine and workspace with no config file at all: first run. */
export function needsSetup(cwd: string): boolean {
  try {
    return loadConfig(cwd, process.env).sources.length === 0;
  } catch {
    return false; // a broken config is reported by the command that loads it
  }
}
