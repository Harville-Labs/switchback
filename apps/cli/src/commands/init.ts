/**
 * `switchback init`: guided configuration. Local endpoints first, each with
 * the models to use from it, then hosted providers one at a time; then which
 * model does what (ADR 0015), and a config file. Every question has a flag so
 * setup can also run unattended (`--yes`).
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  buildSetupConfig,
  parseJsonc,
  planModels,
  projectPaths,
  type SetupAnswers,
  switchbackPaths,
  writeConfigLayer,
} from '@switchback/engine';
import { bold, dim, green, Prompter } from '../prompt.ts';
import { doctor } from './doctor.ts';
import { type InitFlags, SetupError } from './init-flags.ts';
import { chooseLocals } from './init-local.ts';
import { offerWindowsSandbox, setupUserPermissions } from './init-permissions.ts';
import { chooseRemotes } from './init-remote.ts';
import { chooseRoles } from './init-roles.ts';
import { setTelemetry, TELEMETRY_PROMPT } from './telemetry.ts';

export type { InitFlags } from './init-flags.ts';

export async function init(flags: InitFlags): Promise<number> {
  if (!flags.yes && !process.stdin.isTTY) {
    process.stderr.write(
      'switchback init: not a terminal; pass --yes with flags (see `switchback --help`)\n',
    );
    return 2;
  }
  const p = flags.yes ? undefined : new Prompter();
  try {
    return await run(flags, p);
  } catch (err) {
    if (err instanceof SetupError) {
      process.stderr.write(`switchback init: ${err.message}\n`);
      return 2;
    }
    throw err;
  } finally {
    p?.close();
  }
}

async function run(flags: InitFlags, p: Prompter | undefined): Promise<number> {
  if (p) {
    console.log(
      `${bold('Switchback setup')}\n${dim('Add your local endpoints and hosted providers, then choose which model starts, which ones it escalates to, and who reviews.')}\n`,
    );
  }

  // Model servers belong to this machine, so the user config by default; `--scope project` for a team's.
  const file =
    (flags.scope ?? 'user') === 'user'
      ? switchbackPaths().configFile
      : projectPaths(flags.cwd).configFile;
  if (
    existsSync(file) &&
    p &&
    !(await p.confirm(`\n${file} exists. Update it? A backup is kept at .bak.`))
  ) {
    console.log('Nothing changed.');
    return 0;
  }

  const locals = await chooseLocals(flags, p);
  const remotes = await chooseRemotes(flags, p, locals.length === 0);
  if (!locals.length && !remotes.length) {
    if (!p) throw new SetupError('pick at least one model, local or hosted');
    console.log(
      `\nNo models chosen, so nothing was written. Run ${bold('switchback init')} any time to add them.\n`,
    );
    return 0;
  }

  const plan = planModels({ locals, remotes });
  const roles = await chooseRoles(flags, p, plan);
  const tierOf = (alias: string) => plan.find((m) => m.alias === alias)?.tier;
  const escalatesRemote = roles.escalate.flat().some((a) => tierOf(a) === 'remote');
  const usesRemote =
    escalatesRemote ||
    [
      ...roles.start,
      roles.subagents ?? '',
      ...(Array.isArray(roles.review) ? roles.review.flat() : []),
    ].some((a) => tierOf(a) === 'remote');

  const escalationPolicy =
    flags.policy ??
    (p && escalatesRemote
      ? await p.select('\nWhen a model struggles and the next step is a hosted model:', [
          {
            label: 'Escalate automatically',
            value: 'auto' as const,
            hint: 'shows the reason each time',
          },
          { label: 'Ask me first', value: 'ask' as const, hint: 'local steps never ask' },
          {
            label: 'Never escalate',
            value: 'off' as const,
            hint: 'only context overflow and outages move up',
          },
        ])
      : 'auto');

  let budget: SetupAnswers['budget'];
  if (flags.dailyBudget || flags.monthlyBudget) {
    budget = {
      ...(flags.dailyBudget ? { dailyUsd: flags.dailyBudget } : {}),
      ...(flags.monthlyBudget ? { monthlyUsd: flags.monthlyBudget } : {}),
    };
  } else if (p && usesRemote) {
    console.log(
      dim('\nBudgets keep calls on local models once reached. Leave empty for no limit.'),
    );
    const dailyUsd = await p.number('Daily remote budget in USD');
    const monthlyUsd = await p.number('Monthly remote budget in USD');
    if (dailyUsd || monthlyUsd)
      budget = { ...(dailyUsd ? { dailyUsd } : {}), ...(monthlyUsd ? { monthlyUsd } : {}) };
  }

  const answers: SetupAnswers = {
    locals,
    remotes,
    roles,
    escalationPolicy,
    ...(budget ? { budget } : {}),
  };
  const layer = buildSetupConfig(answers);

  if (p) {
    console.log(
      `\n${bold('Configuration to write')} ${dim(file)}\n${JSON.stringify(layer, null, 2)}\n`,
    );
    if (!(await p.confirm('Write it?'))) {
      console.log('Nothing changed.');
      return 0;
    }
  }
  const result = writeConfigLayer(file, layer);
  console.log(
    `${green('✓')} Wrote ${result.file}${result.backup ? dim(` (previous version: ${result.backup})`) : ''}\n`,
  );
  await setupUserPermissions(flags, p);
  await offerWindowsSandbox(p);
  const share =
    flags.telemetry ??
    (p && !telemetryChosen()
      ? await p.confirm(
          `${TELEMETRY_PROMPT}\n${dim('  Details: docs/telemetry.md. Change it any time with `switchback telemetry on|off`.')}\n `,
          false,
        )
      : undefined);
  if (share !== undefined) {
    setTelemetry(share);
    console.log(`${green('✓')} Telemetry ${share ? 'on. Thank you' : 'off'}.\n`);
  }
  await doctor({ cwd: flags.cwd, mock: false });
  return 0;
}

/** Whether the user has answered before (either way): their config says. */
function telemetryChosen(): boolean {
  const file = switchbackPaths().configFile;
  if (!existsSync(file)) return false;
  try {
    const cfg = parseJsonc(readFileSync(file, 'utf8')) as { telemetry?: { enabled?: unknown } };
    return typeof cfg.telemetry?.enabled === 'boolean';
  } catch {
    return false;
  }
}

/** First run, before the TUI opens: straight into setup, which can be answered "no" throughout. */
export async function offerSetup(cwd: string): Promise<number> {
  console.log(`${bold('No Switchback configuration found.')} Let's add your models.\n`);
  return init({
    cwd,
    yes: false,
    noLocal: false,
    localUrls: [],
    localModels: [],
    contextWindows: [],
    remotes: [],
    remoteModels: [],
  });
}
