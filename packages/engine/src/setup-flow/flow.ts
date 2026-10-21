/**
 * Setup, start to finish: on a new install, another agent's setup to start
 * from; local endpoints, remote providers, which model does what, escalation
 * and budgets, then the config file and command permissions.
 * `switchback init` runs it with terminal prompts; clients run it over the
 * protocol (protocol-prompter.ts), so everyone sets up the same way. With no
 * prompter, the flags answer everything (unattended).
 */
import { existsSync } from 'node:fs';
import type { detectLocalServers, listModels } from '@switchback/providers';
import { projectPaths, switchbackPaths } from '../paths.ts';
import { buildSetupConfig, planModels, type SetupAnswers, writeConfigLayer } from '../setup.ts';
import { SetupError, type SetupFlags } from './flags.ts';
import { chooseLocals } from './local.ts';
import { setupUserPermissions } from './permissions.ts';
import { asking, type SetupPrompter, say } from './prompter.ts';
import { chooseRemotes } from './remote.ts';
import { chooseRoles } from './roles.ts';
import { offerStartFrom } from './start-from.ts';

export interface SetupResult {
  /** `nothing`: the person chose not to write anything. */
  outcome: 'written' | 'nothing';
  file: string;
  backup?: string;
}

/** Network lookups and where Switchback's home is, for tests. */
export interface SetupDeps {
  detect?: typeof detectLocalServers;
  list?: typeof listModels;
  env?: Record<string, string | undefined>;
}

export async function runSetup(
  flags: SetupFlags,
  ui: SetupPrompter | undefined,
  deps: SetupDeps = {},
): Promise<SetupResult> {
  const p = asking(ui);
  // Model servers belong to this machine, so the user config by default; `--scope project` for a team's.
  const file =
    (flags.scope ?? 'user') === 'user'
      ? switchbackPaths(deps.env).configFile
      : projectPaths(flags.cwd).configFile;
  const firstRun = !existsSync(file);
  if (!firstRun && p && !(await p.confirm(`${file} exists. Update it? A backup is kept at .bak.`)))
    return { outcome: 'nothing', file };

  const imported = await offerStartFrom(flags, ui, firstRun, deps.env);
  let locals = imported?.locals ?? [];
  let remotes = imported?.remotes ?? [];
  // Unattended, flags add models to an import; asked, the person decides.
  const more = !imported
    ? true
    : p
      ? await p.confirm('Add other models too?', !locals.length && !remotes.length)
      : false;
  if (more || (!p && flags.localModels.length))
    locals = [...locals, ...(await chooseLocals(flags, ui, deps.detect))];
  if (more || (!p && flags.remotes.length))
    remotes = [
      ...remotes,
      ...(await chooseRemotes(flags, ui, locals.length === 0, deps.list, deps.env)),
    ];
  if (!locals.length && !remotes.length) {
    if (!p) throw new SetupError('pick at least one model, local or hosted');
    say(ui, 'No models chosen, so nothing was written. Run setup any time to add them.', 'detail');
    return { outcome: 'nothing', file };
  }

  const plan = planModels({ locals, remotes });
  // The model the other agent started with stays current unless a flag says otherwise.
  const startedWith = imported?.current
    ? plan[[...locals, ...remotes].indexOf(imported.current)]?.alias
    : undefined;
  const roles = await chooseRoles(
    startedWith && !flags.current?.length ? { ...flags, current: [startedWith] } : flags,
    ui,
    plan,
  );
  const tierOf = (alias: string) => plan.find((m) => m.alias === alias)?.tier;
  const escalatesRemote = roles.escalate.flat().some((a) => tierOf(a) === 'remote');
  const usesRemote =
    escalatesRemote ||
    [
      ...roles.current,
      roles.subagents ?? '',
      ...(Array.isArray(roles.review) ? roles.review.flat() : []),
    ].some((a) => tierOf(a) === 'remote');

  const escalationPolicy =
    flags.policy ??
    (p && escalatesRemote
      ? await p.select('When a model struggles and the next step is a hosted model:', [
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
    say(ui, 'Budgets keep calls on local models once reached. Leave empty for no limit.', 'detail');
    const dailyUsd = await p.number('Daily remote budget in USD');
    const monthlyUsd = await p.number('Monthly remote budget in USD');
    if (dailyUsd || monthlyUsd)
      budget = { ...(dailyUsd ? { dailyUsd } : {}), ...(monthlyUsd ? { monthlyUsd } : {}) };
  }

  const layer = buildSetupConfig({
    locals,
    remotes,
    roles,
    escalationPolicy,
    ...(budget ? { budget } : {}),
  });
  if (imported && Object.keys(imported.mcpServers).length) layer.mcpServers = imported.mcpServers;
  if (imported?.agents) {
    const answers = [...locals, ...remotes];
    layer.agents = Object.fromEntries(
      Object.entries(imported.agents).map(([name, a]) => {
        const alias = a.model ? plan[answers.indexOf(a.model)]?.alias : undefined;
        return [name, alias ? { ...a.config, model: alias } : a.config];
      }),
    );
  }
  if (imported?.compaction) layer.compaction = imported.compaction;
  const result = writeConfigLayer(file, layer);
  say(
    ui,
    `Wrote ${result.file}${result.backup ? ` (previous version: ${result.backup})` : ''}`,
    'success',
  );
  await setupUserPermissions(ui, deps.env, imported?.permissions);
  return {
    outcome: 'written',
    file: result.file,
    ...(result.backup ? { backup: result.backup } : {}),
  };
}
