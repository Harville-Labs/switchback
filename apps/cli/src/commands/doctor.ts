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
    `  mode ${r.mode}; local=${r.local} (${config.models[r.local]?.model ?? 'missing'}), remote=${r.remote} (${config.models[r.remote]?.model ?? 'missing'})`,
  );
  out(
    `  escalation ${r.escalation.policy}; budget ${r.budget.dailyUsd ? `$${r.budget.dailyUsd}/day ` : ''}${r.budget.monthlyUsd ? `$${r.budget.monthlyUsd}/month` : r.budget.dailyUsd ? '' : 'unlimited'}`,
  );
  if (!config.models[r.local]) problems++;
  if (!config.models[r.remote]) problems++;

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
