/**
 * Setup's first question on a new install: start from another coding agent's
 * setup? Only agents whose config is found here are offered, and only once
 * (no Switchback config yet), so it never gets in the way of re-running setup.
 * `--from <agent>` picks one unattended. See ADR 0022.
 */
import { tildify } from '../paths.ts';
import { REMOTE_PROVIDERS } from '../setup.ts';
import { SetupError, type SetupFlags } from './flags.ts';
import { findOpenCodeConfigs, type Imported, readOpenCode } from './from-opencode.ts';
import { type Env, hasKey, keyEnv } from './keys.ts';
import { asking, type SetupPrompter, say } from './prompter.ts';

export const HARNESSES = {
  opencode: { name: 'OpenCode', find: findOpenCodeConfigs, read: readOpenCode },
} as const;
export type Harness = keyof typeof HARNESSES;

export async function offerStartFrom(
  flags: SetupFlags,
  ui: SetupPrompter | undefined,
  firstRun: boolean,
  env: Env = process.env,
): Promise<Imported | undefined> {
  const p = asking(ui);
  if (flags.from) {
    const h = HARNESSES[flags.from];
    const files = h.find(flags.cwd, env);
    if (!files.length) throw new SetupError(`--from ${flags.from}: no ${h.name} config found`);
    return report(h.name, h.read(files, env), ui, env);
  }
  if (!p || !firstRun) return undefined;
  const found = Object.entries(HARNESSES)
    .map(([id, h]) => ({ id: id as Harness, h, files: h.find(flags.cwd, env) }))
    .filter((x) => x.files.length);
  if (!found.length) return undefined;
  const pick = await p.select(
    'Coming from another coding agent? Switchback can start from its setup.',
    [
      ...found.map(({ id, h, files }) => ({
        label: `Start from my ${h.name} setup`,
        value: id as Harness | '',
        hint: files.map((f) => tildify(f)).join(', '),
      })),
      { label: 'No, start fresh', value: '' as const },
    ],
  );
  if (!pick) return undefined;
  const h = HARNESSES[pick];
  const chosen = found.find((x) => x.id === pick);
  return report(h.name, h.read(chosen?.files ?? [], env), ui, env);
}

/** What came over and what didn't, before the rest of setup builds on it. */
function report(name: string, got: Imported, ui: SetupPrompter | undefined, env: Env): Imported {
  say(ui, `From ${name}`, 'heading');
  const models = [...got.locals.map((l) => l.model), ...got.remotes.map((r) => r.model)];
  say(
    ui,
    models.length ? `Models: ${models.join(', ')}` : 'No models it uses could come over.',
    'detail',
  );
  const servers = Object.keys(got.mcpServers);
  if (servers.length) say(ui, `MCP servers: ${servers.join(', ')}`, 'detail');
  if (got.permissions)
    say(ui, 'Permissions: its levels and patterns, as Switchback rules', 'detail');
  else
    say(
      ui,
      `${name} runs edits and commands without asking unless told otherwise; Switchback asks first.`,
      'detail',
    );
  // Credentials stay where that agent keeps them; say what Switchback will need.
  const hints = new Set<string>();
  for (const r of got.remotes) {
    const name = keyEnv(r.kind);
    if (name && !r.apiKey && !hasKey(r.kind, env))
      hints.add(`${REMOTE_PROVIDERS[r.kind].name} needs ${name}`);
  }
  for (const h of hints) say(ui, h, 'warning');
  for (const s of got.skipped) say(ui, `Not brought over: ${s}`, 'warning');
  return got;
}
