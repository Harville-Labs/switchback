/** `switchback doctor`: explain the effective configuration and check every provider. */
import { formatMcpServers, formatPermissions, formatRoles, modeLabel } from '@switchback/client';
import { configRoles, modelSummaries, roleAliases, tierOfModel } from '@switchback/engine';
import { createProvider, tierOf } from '@switchback/providers';
import { type CommonFlags, createEngine } from '../bootstrap.ts';

export async function doctor(flags: CommonFlags): Promise<number> {
  const { engine, loaded, agentErrors } = createEngine(flags, 'deny');
  const { config } = loaded;
  const out = (s = '') => process.stdout.write(`${s}\n`);
  let problems = 0;

  out('Config files');
  if (loaded.sources.length === 0) out('  (none; using built-in defaults)');
  for (const s of loaded.sources) out(`  ${s}`);

  if (loaded.org) {
    const o = loaded.org;
    out(`\nOrganization\n  ${o.name} (${o.id}), policy revision ${o.version}`);
    for (const n of o.notes) out(`  ${n}`);
    if (o.enforcedKeys.length) out(`  enforced: ${o.enforcedKeys.join(', ')}`);
  }

  out('\nProviders');
  const used = new Set(Object.values(config.models).map((m) => m.provider));
  for (const [id, pc] of Object.entries(config.providers)) {
    if (!used.has(id)) {
      out(`  - ${id} (${pc.type}): not used by any model`);
      continue;
    }
    const status = await createProvider(id, pc).health();
    if (!status.ok) problems++;
    out(
      `  ${status.ok ? '✓' : '✗'} ${id} (${pc.type}, ${tierOf(pc)}): ${status.detail}${status.latencyMs !== undefined ? ` [${status.latencyMs}ms]` : ''}`,
    );
    // Local servers list exactly what they serve; hosted catalogs use other names and aliases.
    if (!status.models || tierOf(pc) !== 'local') continue;
    out(`    serves ${status.models.join(', ') || 'no models'}`);
    for (const [alias, m] of Object.entries(config.models)) {
      if (m.provider !== id || status.models.includes(m.model)) continue;
      problems++;
      out(`    ✗ models.${alias}: ${id} doesn't serve "${m.model}"`);
    }
  }

  out('\nRouting');
  const r = config.routing;
  for (const line of formatRoles(configRoles(config), modelSummaries(config)).split('\n'))
    out(`  ${line}`);
  if (r.classifier) {
    const c = config.models[r.classifier.model];
    out(
      `  classifier ${r.classifier.model}${c ? ` (${c.model}, ${tierOfModel(config, r.classifier.model)})` : ''}; escalates ${r.classifier.escalateOn} prompts`,
    );
  }
  if (!r.allowRemote) out('  remote models are turned off (routing.allowRemote: false)');
  out(
    `  escalation ${r.escalation.policy}; budget ${r.budget.dailyUsd ? `$${r.budget.dailyUsd}/day ` : ''}${r.budget.monthlyUsd ? `$${r.budget.monthlyUsd}/month` : r.budget.dailyUsd ? '' : 'unlimited'}`,
  );
  const locals = roleAliases(r).flatMap((alias) => {
    const m = config.models[alias];
    const pc = m && config.providers[m.provider];
    return m && pc && tierOfModel(config, alias) === 'local' ? [{ alias, m, pc }] : [];
  });
  for (const { alias, m, pc } of locals) {
    if (m.contextWindow) {
      out(`  ${alias} context window ${m.contextWindow.toLocaleString('en-US')} (configured)`);
      continue;
    }
    const found = await createProvider(m.provider, pc)
      .contextWindow?.(m.model)
      .catch(() => undefined);
    if (found) {
      out(
        `  ${alias} context window ${found.contextWindow.toLocaleString('en-US')} (detected from ${found.source})`,
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

  const { servers } = await engine.mcpStatus();
  if (servers.length) {
    out('\nMCP servers');
    out(formatMcpServers(servers));
    problems += servers.filter((s) => s.state === 'failed' || s.state === 'untrusted').length;
  }
  out('\nPermissions');
  out(
    formatPermissions(await engine.permissions())
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  out(`  new sessions start in ${modeLabel(config.permissions.defaultMode)} mode`);
  const hookCount = Object.values(config.hooks).reduce((n, m) => n + (m?.length ?? 0), 0);
  out(`\nHooks\n  ${hookCount} configured`);
  if (loaded.untrustedHooks.length) {
    problems++;
    out(
      `  ✗ ${loaded.untrustedHooks.length} project hook(s) waiting for trust; see \`switchback hooks\``,
    );
  }
  await engine.shutdown();

  out('\nAgents');
  for (const a of engine.listAgents())
    out(
      `  ${a.name} [${a.source}${a.route !== 'auto' ? `, ${a.route}` : ''}${a.model ? `, ${a.model}` : ''}]: ${a.description}`,
    );
  for (const e of agentErrors) {
    problems++;
    out(`  ✗ ${e}`);
  }

  out(problems ? `\n${problems} problem(s) found.` : '\nAll good.');
  return problems ? 1 : 0;
}
