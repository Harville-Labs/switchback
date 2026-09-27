/** `harness doctor`: explain the effective configuration and check every provider. */
import { formatMcpServers } from '@harness/client';
import { createProvider, tierOf } from '@harness/providers';
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
  out(`  mode ${r.mode}`);
  const chainLine = (tier: 'local' | 'remote') =>
    r[tier]
      .map((alias) => `${alias} (${config.models[alias]?.model ?? 'not configured'})`)
      .join(' → ');
  out(`  local  ${chainLine('local')}`);
  out(`  remote ${chainLine('remote')}`);
  out(
    `  escalation ${r.escalation.policy}; budget ${r.budget.dailyUsd ? `$${r.budget.dailyUsd}/day ` : ''}${r.budget.monthlyUsd ? `$${r.budget.monthlyUsd}/month` : r.budget.dailyUsd ? '' : 'unlimited'}`,
  );
  const locals = r.local.flatMap((alias) => {
    const m = config.models[alias];
    const pc = m && config.providers[m.provider];
    return m && pc ? [{ alias, m, pc }] : [];
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
  if (!locals.length && r.mode !== 'remote-only') {
    problems++;
    out('  ✗ no local model configured; run `harness init` to pick one');
  }
  if (!r.remote.some((a) => config.models[a]) && r.mode !== 'local-only') {
    problems++;
    out('  ✗ no remote model configured; run `harness init`');
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
