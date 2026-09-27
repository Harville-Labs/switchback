import { HarnessClient } from '@harness/client';
import {
  ConfigError,
  Engine,
  type EngineOptions,
  type HarnessConfig,
  loadConfig,
  OrgSync,
  readAuth,
  refreshPolicy,
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
 * add mock local/remote models where none are configured, for demos and UI work with no
 * model running.
 */
export function mockify(config: HarnessConfig): HarnessConfig {
  const providers: HarnessConfig['providers'] = {};
  for (const [id, pc] of Object.entries(config.providers))
    providers[id] = { type: 'mock', tier: tierOf(pc) };
  const models = { ...config.models };
  for (const tier of ['local', 'remote'] as const) {
    const alias = config.routing[tier];
    // Never invent a remote tier that policy or config has switched off.
    if (models[alias] || (tier === 'remote' && config.routing.mode === 'local-only')) continue;
    providers[`mock-${tier}`] = { type: 'mock', tier };
    models[alias] = {
      provider: `mock-${tier}`,
      model: `mock-${tier}`,
      contextWindow: 32_768,
      maxOutputTokens: 16_000,
    };
  }
  return { ...config, providers, models };
}

function load(flags: CommonFlags) {
  const loaded = loadConfig(flags.cwd, process.env);
  if (flags.mock) loaded.config = mockify(loaded.config);
  return loaded;
}

export function createEngine(
  flags: CommonFlags,
  interaction: EngineOptions['interaction'],
  options: { syncOrg?: boolean } = {},
) {
  try {
    const loaded = load(flags);
    const { engine, agentErrors } = Engine.fromWorkspace(flags.cwd, loaded.config, {
      prices: loaded.prices,
      ...(interaction ? { interaction } : {}),
      ...(loaded.org ? { org: loaded.org } : {}),
    });
    if (options.syncOrg && readAuth()) {
      // Long-running engines follow policy updates live.
      new OrgSync({
        onPolicyChanged: () => {
          try {
            engine.applyConfig(load(flags));
          } catch (err) {
            engine.notify('error', `organization policy not applied: ${(err as Error).message}`);
          }
        },
        usageSince: (iso) => engine.usageEntriesSince(iso),
        onError: (message) => engine.notify('warn', message),
      }).start();
    }
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
  options: { syncOrg?: boolean } = {},
) {
  await refreshOrgPolicyQuickly();
  const { engine, agentErrors } = createEngine(flags, interaction, options);
  const [serverSide, clientSide] = createTransportPair();
  serve(engine, serverSide);
  const client = new HarnessClient(clientSide);
  const init = await client.initialize({ name: clientName, version: CLI_VERSION }, flags.cwd);
  return { client, init, agentErrors };
}

/**
 * Pick up a newer organization policy before starting, without letting a slow
 * or unreachable server delay startup by more than a few seconds. The cached
 * policy applies either way.
 */
export async function refreshOrgPolicyQuickly(timeoutMs = 3000): Promise<void> {
  if (!readAuth()) return;
  await Promise.race([refreshPolicy().catch(() => undefined), Bun.sleep(timeoutMs)]);
}

/** True on a machine and workspace with no config file at all: first run. */
export function needsSetup(cwd: string): boolean {
  try {
    // Signed in to an organization counts as configured.
    if (readAuth()) return false;
    return loadConfig(cwd, process.env).sources.length === 0;
  } catch {
    return false; // a broken config is reported by the command that loads it
  }
}
