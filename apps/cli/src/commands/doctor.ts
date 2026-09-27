/** `harness doctor`: explain the effective configuration and check every provider. */
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
  out(
    `  mode ${r.mode}; local=${r.local} (${config.models[r.local]?.model ?? 'not configured'}), remote=${r.remote} (${config.models[r.remote]?.model ?? 'not configured'})`,
  );
  out(
    `  escalation ${r.escalation.policy}; budget ${r.budget.dailyUsd ? `$${r.budget.dailyUsd}/day ` : ''}${r.budget.monthlyUsd ? `$${r.budget.monthlyUsd}/month` : r.budget.dailyUsd ? '' : 'unlimited'}`,
  );
  const local = config.models[r.local];
  const localProvider = local && config.providers[local.provider];
  if (local && localProvider) {
    if (local.contextWindow) {
      out(`  local context window ${local.contextWindow.toLocaleString('en-US')} (configured)`);
    } else {
      const found = await createProvider(local.provider, localProvider)
        .contextWindow?.(local.model)
        .catch(() => undefined);
      if (found) {
        out(
          `  local context window ${found.contextWindow.toLocaleString('en-US')} (detected from ${found.source})`,
        );
      } else {
        problems++;
        out(
          `  ✗ local context window unknown; set models.${r.local}.contextWindow (assuming 8,192)`,
        );
      }
    }
  }
  if (!local && r.mode !== 'remote-only') {
    problems++;
    out('  ✗ no local model configured; run `harness init` to pick one');
  }
  if (!config.models[r.remote] && r.mode !== 'local-only') {
    problems++;
    out('  ✗ no remote model configured; run `harness init`');
  }

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
