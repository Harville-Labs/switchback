/** `switchback doctor`: explain the effective configuration and check every provider. */
import { homedir } from 'node:os';
import { formatMcpServers, formatPermissions, formatRoles, modeLabel } from '@switchback/client';
import {
  configRoles,
  instructionFiles,
  instructionsUsage,
  modelSummaries,
  roleAliases,
  tierOfModel,
} from '@switchback/engine';
import { createProvider, tierOf } from '@switchback/providers';
import { type CommonFlags, createEngine } from '../bootstrap.ts';
import { bold, cyan, dim, green, red, yellow } from '../prompt.ts';
import { heading, marked, summary, tildify } from './doctor-style.ts';

const style = { bold, dim, green, red, yellow, cyan };

export async function doctor(flags: CommonFlags): Promise<number> {
  const { engine, loaded, agentErrors } = createEngine(flags, 'deny');
  const { config } = loaded;
  const out = (s = '') =>
    process.stdout.write(
      `${s
        .split('\n')
        .map((l) => marked(style, l))
        .join('\n')}\n`,
    );
  const section = (title: string, note?: string) => out(`\n${heading(style, title, note)}`);
  let problems = 0;

  out(heading(style, 'Config files'));
  if (loaded.sources.length === 0) out(dim('  (none; using built-in defaults)'));
  for (const s of loaded.sources) out(`  ${tildify(s, homedir())}`);

  if (loaded.org) {
    const o = loaded.org;
    section('Organization');
    out(`  ${o.name} ${dim(`(${o.id}), policy revision ${o.version}`)}`);
    for (const n of o.notes) out(`  ${n}`);
    if (o.enforcedKeys.length) out(`  enforced: ${o.enforcedKeys.join(', ')}`);
  }

  section('Providers');
  const used = new Set(Object.values(config.models).map((m) => m.provider));
  for (const [id, pc] of Object.entries(config.providers)) {
    if (!used.has(id)) {
      out(`  - ${id} (${pc.type}): not used by any model`);
      continue;
    }
    const status = await createProvider(id, pc).health();
    if (!status.ok) problems++;
    const latency = status.latencyMs !== undefined ? dim(` [${status.latencyMs}ms]`) : '';
    out(
      `  ${status.ok ? '✓' : '✗'} ${bold(id)} ${dim(`(${pc.type}, ${tierOf(pc)})`)}: ${status.detail}${latency}`,
    );
    // Local servers list exactly what they serve; hosted catalogs use other names and aliases.
    if (!status.models || tierOf(pc) !== 'local') continue;
    out(dim(`    serves ${status.models.join(', ') || 'no models'}`));
    for (const [alias, m] of Object.entries(config.models)) {
      if (m.provider !== id || status.models.includes(m.model)) continue;
      problems++;
      out(`    ✗ models.${alias}: ${id} doesn't serve "${m.model}"`);
    }
  }

  section('Routing');
  const r = config.routing;
  for (const line of formatRoles(configRoles(config), modelSummaries(config)).split('\n'))
    out(`  ${line}`);
  if (!r.allowRemote) out('  remote models are turned off (routing.allowRemote: false)');
  out(
    `  escalation ${r.escalation.policy}; budget ${r.budget.dailyUsd ? `$${r.budget.dailyUsd}/day ` : ''}${r.budget.monthlyUsd ? `$${r.budget.monthlyUsd}/month` : r.budget.dailyUsd ? '' : 'unlimited'}`,
  );
  const locals = roleAliases(r).flatMap((alias) => {
    const m = config.models[alias];
    const pc = m && config.providers[m.provider];
    return m && pc && tierOfModel(config, alias) === 'local' ? [{ alias, m, pc }] : [];
  });
  // Local windows are the tight ones; instructions are measured against them below.
  const windows: number[] = [];
  for (const { alias, m, pc } of locals) {
    if (m.contextWindow) {
      windows.push(m.contextWindow);
      out(
        `  ${alias} context window ${m.contextWindow.toLocaleString('en-US')} ${dim('(configured)')}`,
      );
      continue;
    }
    const found = await createProvider(m.provider, pc)
      .contextWindow?.(m.model)
      .catch(() => undefined);
    if (found) {
      windows.push(found.contextWindow);
      out(
        `  ${alias} context window ${found.contextWindow.toLocaleString('en-US')} ${dim(`(detected from ${found.source})`)}`,
      );
    } else {
      problems++;
      out(
        `  ✗ ${alias} context window unknown; set models.${alias}.contextWindow (assuming 8,192)`,
      );
    }
  }
  if (!roleAliases(r).some((a) => config.models[a])) {
    problems++;
    out('  ✗ no model is in routing.start or routing.escalate; run `switchback init`');
  } else if (!r.start.some((a) => config.models[a])) {
    out('  no start model: turns begin on step 1');
  }

  section('Instructions', 'in every session and subagent');
  const usage = instructionsUsage(instructionFiles(flags.cwd), windows);
  if (!usage.files.length) out("  no AGENTS.md (yours or the project's)");
  for (const f of usage.files)
    out(`  ${tildify(f.path, homedir())}: ${bold(f.tokens.toLocaleString('en-US'))} tokens`);
  if (usage.files.length > 1) out(`  total: ${usage.total.toLocaleString('en-US')} tokens`);
  if (usage.window && usage.total)
    out(
      `  ${((usage.total / usage.window) * 100).toFixed(1)}% of the smallest local window (${usage.window.toLocaleString('en-US')})`,
    );
  if (usage.warning) out(`  ! ${usage.warning}`);

  const { servers } = await engine.mcpStatus();
  if (servers.length) {
    section('MCP servers');
    out(formatMcpServers(servers));
    problems += servers.filter((s) => s.state === 'failed' || s.state === 'untrusted').length;
  }
  section('Permissions');
  out(
    formatPermissions(await engine.permissions())
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  out(`  new sessions start in ${modeLabel(config.permissions.defaultMode)} mode`);
  const hookCount = Object.values(config.hooks).reduce((n, m) => n + (m?.length ?? 0), 0);
  section('Hooks');
  out(`  ${hookCount} configured`);
  if (loaded.untrustedHooks.length) {
    problems++;
    out(
      `  ✗ ${loaded.untrustedHooks.length} project hook(s) waiting for trust; see \`switchback hooks\``,
    );
  }
  await engine.shutdown();

  section('Agents');
  for (const a of engine.listAgents())
    out(
      `  ${bold(a.name)} ${dim(`[${a.source}${a.route !== 'auto' ? `, ${a.route}` : ''}${a.model ? `, ${a.model}` : ''}]`)} ${dim(a.description)}`,
    );
  for (const e of agentErrors) {
    problems++;
    out(`  ✗ ${e}`);
  }

  out(`\n${summary(style, problems)}`);
  return problems ? 1 : 0;
}
