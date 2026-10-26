/**
 * OpenCode's agents and compaction settings in Switchback's terms. Agents
 * choose tools rather than carry permission rules, so a denied tool becomes a
 * tool list without it; anything finer stays with the global rules.
 */
import { BUILTIN_AGENTS } from '../agents.ts';
import { translatePermissions } from '../dialects/opencode-format.ts';
import type { LocalAnswer, RemoteAnswer } from '../setup.ts';
import { type Obj, obj, str } from './opencode-models.ts';

/** An agent's config entry, and the model it names (an alias once setup has planned them). */
export interface ImportedAgent {
  config: Obj;
  model?: LocalAnswer | RemoteAnswer;
}

/** Agents OpenCode runs for itself (session titles, summaries); Switchback does these its own way. */
export const OPENCODE_INTERNAL_AGENTS = new Set(['title', 'summary', 'compaction']);

/** Tools an agent can be given; the rest (todo, skill, docs, escalate) every agent has. */
const GRANTABLE = [
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'bash',
  'task',
  'webfetch',
  'websearch',
  'merge_worktree',
];

/** OpenCode's tool and permission names, and the Switchback tools each covers. */
const COVERS: Record<string, string[]> = {
  read: ['read'],
  glob: ['glob'],
  list: ['glob'],
  grep: ['grep'],
  edit: ['edit', 'write', 'merge_worktree'],
  write: ['edit', 'write', 'merge_worktree'],
  patch: ['edit', 'write', 'merge_worktree'],
  multiedit: ['edit', 'write', 'merge_worktree'],
  bash: ['bash'],
  shell: ['bash'],
  task: ['task'],
  subagent: ['task'],
  webfetch: ['webfetch'],
  websearch: ['websearch'],
};

/**
 * `agent` (both formats, after `olderFormat`) as config entries. `modelFor`
 * finds the setup answer for a `provider/model#variant` reference;
 * `mcpServers` are kept in a narrowed tool list, as OpenCode keeps them.
 */
export function translateAgents(
  agents: Obj,
  modelFor: (ref: string) => LocalAnswer | RemoteAnswer | undefined,
  mcpServers: string[],
  skipped: string[],
): Record<string, ImportedAgent> {
  const out: Record<string, ImportedAgent> = {};
  const internal: string[] = [];
  for (const [name, raw] of Object.entries(agents)) {
    if (OPENCODE_INTERNAL_AGENTS.has(name)) {
      internal.push(name);
      continue;
    }
    const a = obj(raw);
    const builtin = BUILTIN_AGENTS.find((b) => b.name === name);
    const config: Obj = {};
    const description = str(a.description);
    if (description) config.description = description;
    else if (!builtin) config.description = `The "${name}" agent from OpenCode.`;
    // V2 calls the prompt `system`.
    const prompt = str(a.prompt) ?? str(a.system);
    if (prompt?.startsWith('{file:'))
      skipped.push(
        `agent ${name}'s prompt is a file reference; copy the file's text into its prompt`,
      );
    else if (prompt) config.prompt = prompt;
    if (a.mode === 'primary' || a.mode === 'subagent' || a.mode === 'all') config.mode = a.mode;
    const steps = a.steps ?? a.maxSteps;
    if (typeof steps === 'number' && Number.isInteger(steps) && steps > 0) config.maxSteps = steps;
    if (a.disable === true || a.disabled === true) config.disable = true;
    const tools = narrowedTools(name, a, builtin?.tools, mcpServers, skipped);
    if (tools) config.tools = tools;
    const permissions = agentPermissionsOf(a, skipped);
    if (permissions) config.permissions = permissions;
    const color = str(a.color);
    if (color && /^#?[0-9a-fA-F]{6}$/.test(color)) config.color = color;
    else if (color)
      skipped.push(
        `agent ${name}'s color ${color}: Switchback colors are six hex digits, like 4C8BF5`,
      );
    const body = obj(obj(a.request).body);
    if (
      a.temperature !== undefined ||
      a.top_p !== undefined ||
      body.temperature !== undefined ||
      body.top_p !== undefined
    )
      skipped.push(
        `agent ${name}'s temperature and top_p: Switchback sets these per model; give its model the settings`,
      );

    const ref = str(a.model);
    const model = ref ? modelFor(ref) : undefined;
    if (ref && !model) skipped.push(`agent ${name}'s model ${ref}: that model didn't come over`);
    if (Object.keys(config).length || model) out[name] = { config, ...(model ? { model } : {}) };
  }
  if (internal.length)
    skipped.push(
      `OpenCode's own ${internal.join(', ')} agent settings: Switchback names and summarizes sessions itself`,
    );
  return out;
}

/**
 * An agent's `permission` as the stricter-only `permissions` config entry:
 * levels of `ask` or `deny`, and ask and deny rules. `allow` has no effect on
 * an agent (it can't loosen the config), so it isn't carried.
 */
function agentPermissionsOf(a: Obj, skipped: string[]): Obj | undefined {
  if (a.permission === undefined) return undefined;
  // Delegation is the agent's tool list (`task`), handled with the denied tools.
  const { subagent: _s, task: _t, ...rest } = obj(a.permission);
  const imported = translatePermissions(
    { permission: typeof a.permission === 'string' ? a.permission : rest },
    skipped,
  );
  if (!imported) return undefined;
  const levels = Object.fromEntries(
    Object.entries(imported.levels).filter(([, level]) => level === 'ask' || level === 'deny'),
  );
  const out: Obj = {
    ...levels,
    ...(imported.ask.length ? { ask: imported.ask } : {}),
    ...(imported.deny.length ? { deny: imported.deny } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/**
 * The tools left after the agent's denials, or undefined when it denies none.
 * A built-in agent that already has fewer keeps only those.
 */
function narrowedTools(
  name: string,
  a: Obj,
  base: string[] | undefined,
  mcpServers: string[],
  skipped: string[],
): string[] | undefined {
  const denied = new Set<string>();
  const finer: string[] = [];
  for (const [tool, on] of Object.entries(obj(a.tools)))
    if (on === false) {
      if (COVERS[tool]) for (const t of COVERS[tool]) denied.add(t);
      else finer.push(tool);
    }
  // Other levels and patterns come over as the agent's own `permissions`.
  for (const [action, rule] of Object.entries(obj(a.permission))) {
    const level = typeof rule === 'string' ? rule : obj(rule)['*'];
    if (level === 'deny' && COVERS[action]) for (const t of COVERS[action]) denied.add(t);
  }
  if (finer.length)
    skipped.push(
      `agent ${name}'s rules for ${[...new Set(finer)].join(', ')}: Switchback agents choose tools, not rules, so the global rules apply`,
    );
  if (!denied.size) return undefined;
  return [
    ...(base ?? GRANTABLE).filter((t) => !denied.has(t)),
    ...(base ? [] : mcpServers.map((s) => `mcp__${s}`)),
  ];
}

/**
 * `compaction`: `auto` turns it on or off. The newer `keep.tokens` and
 * `buffer` (or the older `reserved`) are token counts, which become fractions
 * of the current model's window, within Switchback's limits.
 */
export function translateCompaction(
  cfg: Obj,
  window: number | undefined,
  skipped: string[],
): Obj | undefined {
  const c = obj(cfg.compaction);
  const out: Obj = {};
  if (typeof c.auto === 'boolean') out.enabled = c.auto;
  const keep = obj(c.keep).tokens;
  const buffer = c.buffer ?? c.reserved;
  const counts = typeof keep === 'number' || typeof buffer === 'number';
  if (counts && !window)
    skipped.push(
      "compaction's token counts: the current model's context window isn't known, so Switchback's fractions apply",
    );
  else if (window) {
    const clamp = (v: number, lo: number, hi: number) =>
      Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;
    if (typeof buffer === 'number') out.threshold = clamp(1 - buffer / window, 0.2, 0.95);
    if (typeof keep === 'number') out.keepRecent = clamp(keep / window, 0.05, 0.6);
  }
  return Object.keys(out).length ? out : undefined;
}
