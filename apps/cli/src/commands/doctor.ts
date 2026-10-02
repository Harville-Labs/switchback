/** `switchback doctor`: explain the effective configuration and check every provider. */
import { formatMcpServers } from '@switchback/client';
import { roleAliases } from '@switchback/engine';
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
  }

  out('\nRouting');
  const r = config.routing;
  const tierOfAlias = (alias: string) => {
    const m = config.models[alias];
    const pc = m && config.providers[m.provider];
    return pc ? tierOf(pc) : undefined;
  };
  const label = (alias: string) => {
    const m = config.models[alias];
    return m ? `${alias} (${m.model}, ${tierOfAlias(alias)})` : `${alias} (not configured)`;
  };
  out(`  start    ${r.start.map(label).join(' | ') || '(none)'}`);
  for (const [i, step] of r.escalate.entries())
    out(`  step ${i + 1}   ${step.map(label).join(' | ')}`);
  if (!r.allowRemote) out('  remote models are turned off (routing.allowRemote: false)');
  out(
    `  escalation ${r.escalation.policy}; budget ${r.budget.dailyUsd ? `$${r.budget.dailyUsd}/day ` : ''}${r.budget.monthlyUsd ? `$${r.budget.monthlyUsd}/month` : r.budget.dailyUsd ? '' : 'unlimited'}`,
  );
  const locals = roleAliases(r).flatMap((alias) => {
    const m = config.models[alias];
    const pc = m && config.providers[m.provider];
    return m && pc && tierOf(pc) === 'local' ? [{ alias, m, pc }] : [];
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
