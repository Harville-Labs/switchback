/**
 * `switchback telemetry [status|on|off|preview]`: opt in or out of anonymous
 * usage statistics, and see exactly what would be sent (docs/telemetry.md).
 */
import {
  loadConfig,
  optIn,
  optOut,
  pendingReports,
  readAuth,
  readTelemetryState,
  switchbackPaths,
  telemetryOptedOut,
  telemetryTarget,
  todaysReport,
  writeConfigLayer,
} from '@switchback/engine';
import { CLI_VERSION, type CommonFlags, createEngine } from '../bootstrap.ts';
import { bold, dim, green, yellow } from '../prompt.ts';

export const TELEMETRY_PROMPT =
  'Share anonymous usage statistics with Harville Labs? Daily counts, token totals, and costs only; never prompts, code, file names, or paths.';

/**
 * Always the user's config: telemetry is a personal choice, so it never goes
 * in a project file the rest of a team would share.
 */
export function setTelemetry(enabled: boolean): void {
  writeConfigLayer(switchbackPaths().configFile, { telemetry: { enabled } });
  const { dataDir } = switchbackPaths();
  if (enabled) optIn(dataDir, new Date());
  else optOut(dataDir);
}

export async function telemetry(sub: string | undefined, flags: CommonFlags): Promise<number> {
  const { dataDir } = switchbackPaths();
  switch (sub ?? 'status') {
    case 'on':
      setTelemetry(true);
      console.log(
        `${green('✓')} Telemetry on. Thank you. ${dim('`switchback telemetry preview` shows what is sent; `switchback telemetry off` stops it.')}`,
      );
      return reportEffective(flags, true);
    case 'off':
      setTelemetry(false);
      console.log(`${green('✓')} Telemetry off. Nothing further is collected or sent.`);
      return reportEffective(flags, false);
    case 'status': {
      const { config } = loadConfig(flags.cwd, process.env);
      const state = readTelemetryState(dataDir);
      console.log(
        `${bold('Telemetry')} ${config.telemetry.enabled ? green('on') : 'off'}${telemetryOptedOut(process.env) ? dim(' (forced off by DO_NOT_TRACK / SWITCHBACK_TELEMETRY)') : ''}`,
      );
      const auth = readAuth();
      console.log(
        `  sent to      ${telemetryTarget({ config, ...(auth ? { site: { server: auth.server, accessToken: '' } } : {}) })}${auth ? dim(` (your site, ${auth.org.name})`) : ''}`,
      );
      if (state) {
        console.log(`  install ID   ${state.installId} ${dim('(random; identifies nothing)')}`);
        console.log(`  opted in     ${state.enabledAt.slice(0, 10)}`);
        console.log(`  sent through ${state.sentThrough ?? 'nothing yet'}`);
      }
      console.log(
        dim('\nWhat is sent: docs/telemetry.md. See it for yourself: switchback telemetry preview'),
      );
      return 0;
    }
    case 'preview': {
      const { engine, loaded } = createEngine(flags, 'deny');
      const ctx = {
        dataDir,
        config: loaded.config,
        organization: !!loaded.org,
        version: CLI_VERSION,
        ledger: engine.usageEntriesSince(''),
        now: new Date(),
      };
      await engine.shutdown();
      if (!readTelemetryState(dataDir)) {
        console.error(dim('Telemetry has never been on, so nothing would be sent.'));
        return 0;
      }
      const reports = pendingReports(ctx);
      if (reports.length) {
        console.error(dim(`The next upload (${reports.length} daily report(s)), exactly:`));
        process.stdout.write(`${JSON.stringify({ reports }, null, 2)}\n`);
      } else {
        console.error(
          dim("Nothing is due yet. Today's report so far, sent after the day ends (UTC):"),
        );
        process.stdout.write(`${JSON.stringify({ reports: [todaysReport(ctx)] }, null, 2)}\n`);
      }
      return 0;
    }
    default:
      process.stderr.write(
        `switchback telemetry: unknown subcommand "${sub}" (status, on, off, preview)\n`,
      );
      return 2;
  }
}

/** A project file, organization policy, or the environment can override the user's choice; say so. */
function reportEffective(flags: CommonFlags, wanted: boolean): number {
  const { config, org } = loadConfig(flags.cwd, process.env);
  if (config.telemetry.enabled === wanted) return 0;
  const why = telemetryOptedOut(process.env)
    ? 'DO_NOT_TRACK or SWITCHBACK_TELEMETRY=0 is set'
    : org
      ? `${org.name} policy sets it`
      : 'a project config file sets it';
  console.log(
    yellow(`  In this workspace it's ${config.telemetry.enabled ? 'on' : 'off'}: ${why}.`),
  );
  return 0;
}
