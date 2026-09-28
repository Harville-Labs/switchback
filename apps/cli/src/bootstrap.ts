import { connectDaemon, HarnessClient } from '@harness/client';
import {
  ConfigError,
  Engine,
  type EngineOptions,
  type HarnessConfig,
  harnessPaths,
  loadConfig,
  OrgSync,
  optIn,
  readAuth,
  readTelemetryState,
  recordEngineEvent,
  refreshPolicy,
  sendTelemetry,
  serve,
} from '@harness/engine';
import { createTransportPair, type InitializeResult } from '@harness/protocol';
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
    const chain = config.routing[tier];
    const alias = chain[0] ?? tier;
    // Never invent a remote tier that policy or config has switched off.
    if (chain.some((a) => models[a]) || (tier === 'remote' && config.routing.mode === 'local-only'))
      continue;
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
  options: { syncOrg?: boolean; telemetry?: boolean } = {},
) {
  try {
    const loaded = load(flags);
    const { engine, agentErrors } = Engine.fromWorkspace(flags.cwd, loaded.config, {
      prices: loaded.prices,
      untrustedMcp: loaded.untrustedMcp,
      ...(interaction ? { interaction } : {}),
      ...(loaded.org ? { org: loaded.org } : {}),
    });
    if (options.telemetry && !flags.mock) startTelemetry(engine, loaded);
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
 * When telemetry is on (docs/telemetry.md): count this engine's turns and
 * send any complete days that are due, in the background. Never blocks and
 * never reports failures to the user.
 */
function startTelemetry(engine: Engine, loaded: ReturnType<typeof load>): void {
  if (!loaded.config.telemetry.enabled) return;
  const { dataDir } = harnessPaths();
  // Turned on by an organization policy or a config edit rather than `harness telemetry on`.
  if (!readTelemetryState(dataDir)) optIn(dataDir, new Date());
  engine.subscribe((e) => {
    try {
      recordEngineEvent(dataDir, e, new Date());
    } catch {
      // A full disk shouldn't break a session over statistics.
    }
  });
  // Signed in to a site: its telemetry goes there (ADR 0010).
  const auth = readAuth();
  void sendTelemetry({
    dataDir,
    config: loaded.config,
    organization: !!loaded.org,
    version: CLI_VERSION,
    ledger: engine.usageEntriesSince(''),
    now: new Date(),
    ...(auth ? { site: { server: auth.server, accessToken: auth.accessToken } } : {}),
  }).catch(() => {});
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
  const { engine, agentErrors } = createEngine(flags, interaction, { ...options, telemetry: true });
  const [serverSide, clientSide] = createTransportPair();
  serve(engine, serverSide);
  const client = new HarnessClient(clientSide);
  const init = await client.initialize({ name: clientName, version: CLI_VERSION }, flags.cwd);
  return { client, init, agentErrors };
}

/** How to start this same harness as a daemon: the binary, or bun + this script in dev. */
export function selfCommand(): { command: string; args: string[] } {
  const compiled = !Bun.main.endsWith('.ts') && !Bun.main.endsWith('.tsx');
  return compiled
    ? { command: process.execPath, args: [] }
    : { command: process.execPath, args: [Bun.main] };
}

/**
 * Attach to the workspace's shared daemon (starting it if needed) so the TUI
 * and VS Code share live sessions. Falls back to a private in-process engine.
 */
export async function connectShared(
  flags: CommonFlags & { daemon: boolean },
  clientName: string,
): Promise<{ client: HarnessClient; init: InitializeResult; warnings: string[]; shared: boolean }> {
  const warnings: string[] = [];
  // Mock engines are never shared: a daemon must serve real sessions only.
  if (flags.daemon && !flags.mock) {
    const shared = await connectDaemon({
      workspaceRoot: flags.cwd,
      version: CLI_VERSION,
      client: { name: clientName, version: CLI_VERSION },
      spawn: selfCommand(),
      log: (m) => warnings.push(m),
    });
    if (shared) return { ...shared, warnings, shared: true };
  }
  const local = await connectInProcess(flags, 'prompt', clientName, { syncOrg: true });
  return {
    client: local.client,
    init: local.init,
    warnings: [...warnings, ...local.agentErrors.map((e) => `agent skipped: ${e}`)],
    shared: false,
  };
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
    // A repository's .mcp.json alone doesn't mean this machine is set up.
    return !loadConfig(cwd, process.env).sources.some((s) => !s.endsWith('.mcp.json'));
  } catch {
    return false; // a broken config is reported by the command that loads it
  }
}
