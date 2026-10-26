/**
 * A config file that declares Claude Code's settings `$schema`, read as
 * Switchback config: permission rules and mode, hooks, and MCP servers.
 * Switchback's rule syntax and hook events follow Claude Code's, so these come
 * over nearly as written; what has no Switchback form is left out with a note.
 * Claude Code's agents and commands are Markdown files, not settings, so they
 * aren't here (Switchback reads its own `agents/` and `commands/` folders).
 */
import { ruleProblem } from '../permissions/rules.ts';
import { type Obj, obj, str } from '../setup-flow/opencode-models.ts';

const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/** Settings Claude Code has that Switchback sets some other way, or not at all. */
const OTHER_KEYS = ['env', 'model', 'apiKeyHelper', 'statusLine', 'outputStyle', 'enabledPlugins'];

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function translateClaudeCode(raw: Obj): { config: Obj; notes: string[] } {
  const notes: string[] = [];
  const out: Obj = {};

  const p = obj(raw.permissions);
  const permissions: Obj = {};
  for (const behavior of ['allow', 'ask', 'deny'] as const) {
    const kept: string[] = [];
    for (const rule of strings(p[behavior])) {
      const problem = ruleProblem([rule]);
      if (problem) notes.push(`${behavior} rule ${rule}: Switchback has no such rule`);
      else kept.push(rule);
    }
    if (kept.length) permissions[behavior] = kept;
  }
  const mode = str(p.defaultMode);
  if (mode && MODES.includes(mode)) permissions.defaultMode = mode;
  else if (mode) notes.push(`permissions.defaultMode ${mode}: Switchback has no such mode`);
  if (strings(p.additionalDirectories).length)
    notes.push(
      'permissions.additionalDirectories: allow edits there with a rule like edit(/path/**)',
    );
  if (Object.keys(permissions).length) out.permissions = permissions;

  // Same events, matchers, and exit codes; only command hooks run here.
  const hooks: Obj = {};
  for (const [event, matchers] of Object.entries(obj(raw.hooks))) {
    const kept = (Array.isArray(matchers) ? matchers : []).flatMap((m) => {
      const entry = obj(m);
      const commands = (Array.isArray(entry.hooks) ? entry.hooks : []).filter(
        (h) => obj(h).type === 'command' && str(obj(h).command),
      );
      if (commands.length !== (Array.isArray(entry.hooks) ? entry.hooks.length : 0))
        notes.push(`a ${event} hook that isn't a command: Switchback runs only command hooks`);
      return commands.length ? [{ ...entry, hooks: commands }] : [];
    });
    if (kept.length) hooks[event] = kept;
  }
  if (Object.keys(hooks).length) out.hooks = hooks;

  const servers: Obj = {};
  for (const [name, def] of Object.entries(obj(raw.mcpServers))) {
    const s = obj(def);
    if (str(s.command))
      servers[name] = {
        command: s.command,
        ...(strings(s.args).length ? { args: strings(s.args) } : {}),
        ...(Object.keys(obj(s.env)).length ? { env: s.env } : {}),
      };
    else if (str(s.url))
      servers[name] = {
        url: s.url,
        ...(Object.keys(obj(s.headers)).length ? { headers: s.headers } : {}),
      };
    else notes.push(`MCP server ${name}: no command or URL`);
  }
  if (Object.keys(servers).length) out.mcpServers = servers;

  const left = OTHER_KEYS.filter((k) => raw[k] !== undefined);
  if (left.length) notes.push(`${left.join(', ')}: not read from a config file`);
  return { config: out, notes };
}
