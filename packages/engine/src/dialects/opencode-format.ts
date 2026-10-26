/**
 * OpenCode's config in Switchback's terms where the two agree: the newer
 * format read as the older one, and permissions as levels and rules. Shared
 * by setup (`switchback init --from opencode`) and by config files that
 * declare OpenCode's `$schema` (dialects/index.ts). Pure; it reads no files.
 */
import { ruleProblem } from '../permissions/rules.ts';
import { type Obj, obj, str } from '../setup-flow/opencode-models.ts';

type Level = 'allow' | 'ask' | 'deny';

/** Permissions from another agent, in Switchback's terms. */
export interface ImportedPermissions {
  levels: Partial<Record<'read' | 'edit' | 'bash' | 'web' | 'websearch' | 'mcp', Level>>;
  outsideWorkspace?: 'ask' | 'deny';
  allow: string[];
  ask: string[];
  deny: string[];
}

/**
 * OpenCode's newer format in the older one's terms, so one translation reads
 * both: `providers` (`package`, `settings`) as `provider` (`npm`, `options`),
 * `agents` as `agent`, the `permissions` list as a `permission` table, and
 * `mcp.servers` as `mcp`. Where a file has both, the older key wins.
 * V2's provider IDs (`google-vertex`) and V1's `api` (the base URL) are read too.
 */
export function olderFormat(cfg: Obj): Obj {
  const provider: Obj = {};
  for (const [pid, raw] of Object.entries(obj(cfg.providers))) {
    const p = obj(raw);
    provider[pid] = {
      ...p,
      ...(str(p.package) ? { npm: p.package } : {}),
      options: { ...obj(p.settings), ...obj(p.options) },
    };
  }
  const apiFixed: Obj = {};
  for (const [pid, raw] of Object.entries(obj(cfg.provider))) {
    const p = obj(raw);
    const options = obj(p.options);
    if (str(p.api) && !str(options.baseURL))
      apiFixed[pid] = { ...p, options: { ...options, baseURL: p.api } };
  }
  const permission = cfg.permission ?? permissionTable(cfg.permissions);
  const agent: Obj = {};
  for (const [name, raw] of Object.entries({ ...obj(cfg.agents), ...obj(cfg.agent) })) {
    const a = obj(raw);
    const table = a.permission ?? permissionTable(a.permissions);
    agent[name] = table === undefined ? a : { ...a, permission: table };
  }
  // V2's `mcp.timeout` sits beside `servers`; it isn't a server.
  const { servers, ...mcp } = obj(cfg.mcp);
  if (servers !== undefined && !obj(mcp.timeout).type) delete mcp.timeout;
  for (const [name, raw] of Object.entries(obj(servers))) {
    const { disabled, ...s } = obj(raw);
    mcp[name] ??= { ...s, ...(disabled === true ? { enabled: false } : {}) };
  }
  return {
    ...cfg,
    provider: { ...provider, ...obj(cfg.provider), ...apiFixed },
    agent,
    ...(permission !== undefined ? { permission } : {}),
    mcp,
  };
}

/** The newer `permissions` list as a `permission` table; read in order, so a later entry for the same pattern wins, as in OpenCode. */
export function permissionTable(list: unknown): Obj | undefined {
  if (!Array.isArray(list)) return undefined;
  const table: Record<string, Obj> = {};
  for (const raw of list) {
    const r = obj(raw);
    const action = str(r.action);
    if (!action || !isLevel(r.effect)) continue;
    table[action] = { ...table[action], [str(r.resource) ?? '*']: r.effect };
  }
  return table;
}

const LEVELS = new Set(['allow', 'ask', 'deny']);
export const isLevel = (v: unknown): v is Level => typeof v === 'string' && LEVELS.has(v);

/** A path pattern as Switchback writes one: `~/` for home, `//` for the filesystem root. */
function pathSpec(pattern: string): string {
  const p = pattern.replace(/^\$HOME(?=\/|$)/, '~');
  return p.startsWith('/') ? `/${p}` : p;
}

/**
 * OpenCode's `permission` (and the older `tools` switches). Its catch-all and
 * per-tool actions become levels, its patterns rules. OpenCode lets the last
 * matching pattern win; Switchback lets deny beat ask beat allow, so where the
 * two differ the result is stricter, never looser.
 */
export function translatePermissions(cfg: Obj, skipped: string[]): ImportedPermissions | undefined {
  const out: ImportedPermissions = { levels: {}, allow: [], ask: [], deny: [] };
  const rule = (level: Level, text: string) => {
    if (ruleProblem([text])) skipped.push(`permission pattern ${text}: not a Switchback rule`);
    else if (!out[level].includes(text)) out[level].push(text);
  };

  // Legacy switches: `false` turns a tool off.
  for (const [tool, on] of Object.entries(obj(cfg.tools))) {
    if (on !== false) continue;
    if (tool === 'bash') out.levels.bash = 'deny';
    else if (['edit', 'write', 'patch'].includes(tool)) out.levels.edit = 'deny';
    else if (tool === 'webfetch') out.levels.web = 'deny';
    else if (tool === 'websearch') out.levels.websearch = 'deny';
  }

  const perm = cfg.permission;
  if (isLevel(perm))
    for (const k of ['read', 'edit', 'bash', 'web', 'websearch', 'mcp'] as const)
      out.levels[k] = perm;
  const table = obj(perm);
  const all = table['*'];
  if (isLevel(all))
    for (const k of ['read', 'edit', 'bash', 'web', 'websearch', 'mcp'] as const)
      out.levels[k] ??= all;

  const ignored: string[] = [];
  for (const [tool, value] of Object.entries(table)) {
    if (tool === '*') continue;
    const target =
      tool === 'shell' || tool === 'bash'
        ? 'bash'
        : tool === 'read' || tool === 'edit'
          ? tool
          : tool === 'webfetch'
            ? 'web'
            : tool === 'websearch'
              ? 'websearch'
              : tool === 'external_directory'
                ? 'outside'
                : undefined;
    if (!target) {
      ignored.push(tool);
      continue;
    }
    const entries: [string, unknown][] = isLevel(value)
      ? [['*', value]]
      : Object.entries(obj(value));
    for (const [pattern, level] of entries) {
      if (!isLevel(level)) continue;
      if (target === 'outside') {
        // Switchback asks before edits outside the workspace; it can't let everything through.
        if (pattern === '*') {
          if (level === 'deny') out.outsideWorkspace = 'deny';
        } else for (const t of ['read', 'edit']) rule(level, `${t}(${pathSpec(pattern)})`);
        continue;
      }
      if (pattern === '*') {
        out.levels[target] = level;
        continue;
      }
      if (target === 'bash') rule(level, `bash(${pattern})`);
      else if (target === 'read' || target === 'edit')
        rule(level, `${target}(${pathSpec(pattern)})`);
      else if (tool === 'webfetch') {
        const host = /^(?:[a-z]+:\/\/)?([^/*]+)(?:\/.*)?$/i.exec(pattern)?.[1];
        if (host) rule(level, `webfetch(domain:${host})`);
        else skipped.push(`webfetch pattern "${pattern}": Switchback's web rules name domains`);
      }
    }
  }
  if (ignored.length)
    skipped.push(`permission for ${ignored.join(', ')}: Switchback has no such setting`);

  const any =
    Object.keys(out.levels).length ||
    out.outsideWorkspace ||
    out.allow.length ||
    out.ask.length ||
    out.deny.length;
  return any ? out : undefined;
}
