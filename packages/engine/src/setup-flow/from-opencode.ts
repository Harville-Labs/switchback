/**
 * Starting from an OpenCode setup (ADR 0022): its config files, read once
 * when the person picks it during setup, turned into setup answers, MCP
 * servers, and permissions. Nothing here runs after setup; what comes over is
 * ordinary Switchback config the person sees before it's written.
 *
 * Format: opencode.ai/docs/config, /providers, /mcp-servers, /permissions
 * (checked 2026-10-20), and the V2 format with `providers`, `settings`,
 * `modelID`, a `permissions` list, and `mcp.servers` (opencode.ai/v2/docs/migrate-v1,
 * checked 2026-10-22).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { deepMerge, parseJsonc } from '../config.ts';
import { McpServerName } from '../mcp/config.ts';
import { ruleProblem } from '../permissions/rules.ts';
import type { LocalAnswer, RemoteAnswer } from '../setup.ts';
import {
  type ImportedAgent,
  OPENCODE_INTERNAL_AGENTS,
  translateAgents,
  translateCompaction,
} from './opencode-agents.ts';
import {
  envName,
  modelSettings,
  type Obj,
  obj,
  str,
  translateModel,
  variantOf,
} from './opencode-models.ts';

type Env = Record<string, string | undefined>;
type Level = 'allow' | 'ask' | 'deny';

/** Permissions from another agent, in Switchback's terms. */
export interface ImportedPermissions {
  levels: Partial<Record<'read' | 'edit' | 'bash' | 'web' | 'websearch' | 'mcp', Level>>;
  outsideWorkspace?: 'ask' | 'deny';
  allow: string[];
  ask: string[];
  deny: string[];
}

/** What another agent's setup becomes. */
export interface Imported {
  /** Files read, lowest precedence first. */
  files: string[];
  locals: LocalAnswer[];
  remotes: RemoteAnswer[];
  /** The model that agent starts with; one of `locals` or `remotes`. */
  current?: LocalAnswer | RemoteAnswer;
  mcpServers: Record<string, Obj>;
  permissions?: ImportedPermissions;
  /** Agent entries, by name; models are setup answers until setup plans aliases. */
  agents?: Record<string, ImportedAgent>;
  /** A `compaction` config entry. */
  compaction?: Obj;
  /** What didn't come over, and why. */
  skipped: string[];
}

const NAMES = ['opencode.json', 'opencode.jsonc', 'config.json'];

/**
 * OpenCode's config files in its precedence order: global, `OPENCODE_CONFIG`,
 * then the project's from the git root down to `cwd`.
 */
export function findOpenCodeConfigs(cwd: string, env: Env = process.env): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const global = join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode');
  const files = NAMES.map((n) => join(global, n)).filter((f) => existsSync(f));
  if (env.OPENCODE_CONFIG && existsSync(env.OPENCODE_CONFIG)) files.push(env.OPENCODE_CONFIG);
  const project: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    // `config.json` is only OpenCode's in its own directory, not in a project.
    for (const n of NAMES.slice(0, 2).reverse()) {
      const f = join(dir, n);
      if (existsSync(f) && !files.includes(f)) project.unshift(f);
    }
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir || dir === home) break;
  }
  return [...files, ...project];
}

/** Read and merge OpenCode's config files, then translate them. */
export function readOpenCode(files: string[], env: Env = process.env): Imported {
  let merged: Obj = {};
  for (const f of files) {
    try {
      merged = deepMerge(merged, parseJsonc(readFileSync(f, 'utf8')) as Obj);
    } catch (err) {
      throw new Error(`couldn't read ${f}: ${(err as Error).message}`);
    }
  }
  return { files, ...fromOpenCode(merged, env) };
}

/**
 * OpenCode's newer format in the older one's terms, so one translation reads
 * both: `providers` (`package`, `settings`) as `provider` (`npm`, `options`),
 * `agents` as `agent`, the `permissions` list as a `permission` table, and
 * `mcp.servers` as `mcp`. Where a file has both, the older key wins.
 * V2's provider IDs (`google-vertex`) and V1's `api` (the base URL) are read too.
 */
function olderFormat(cfg: Obj): Obj {
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
function permissionTable(list: unknown): Obj | undefined {
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

/** Translate a merged OpenCode config, in either format. */
export function fromOpenCode(raw: Obj, env: Env = process.env): Omit<Imported, 'files'> {
  const cfg = olderFormat(raw);
  const skipped: string[] = [];
  const providers = obj(cfg.provider);
  const disabled = new Set(Array.isArray(cfg.disabled_providers) ? cfg.disabled_providers : []);
  const enabled = Array.isArray(cfg.enabled_providers) ? new Set(cfg.enabled_providers) : undefined;
  const usable = (pid: string) => !disabled.has(pid) && (!enabled || enabled.has(pid));

  // Models in the order they matter: the main model, the small one, agents',
  // then every model a custom endpoint lists.
  const refs: string[] = [];
  // `provider/model#variant`: the same model with other request settings. A
  // variant that sets any becomes a model of its own; one that sets none is the model.
  const bare = (ref: unknown) => str(ref)?.replace(/#.*$/, '');
  const add = (ref: unknown) => {
    const r = bare(ref);
    if (!r?.includes('/')) return;
    if (!refs.includes(r)) refs.push(r);
    const full = str(ref) as string;
    if (full !== r && !refs.includes(full)) refs.push(full);
  };
  add(cfg.model);
  add(cfg.small_model);
  for (const [name, agent] of Object.entries(obj(cfg.agent)))
    if (!OPENCODE_INTERNAL_AGENTS.has(name)) add(obj(agent).model);
  for (const [pid, p] of Object.entries(providers))
    if (str(obj(obj(p).options).baseURL))
      for (const mid of Object.keys(obj(obj(p).models))) add(`${pid}/${mid}`);

  const locals: LocalAnswer[] = [];
  const remotes: RemoteAnswer[] = [];
  let current: LocalAnswer | RemoteAnswer | undefined;
  const byRef = new Map<string, LocalAnswer | RemoteAnswer>();
  const keyNoted = new Set<string>();
  for (const ref of refs) {
    const slash = ref.indexOf('/');
    const pid = ref.slice(0, slash);
    const [mid = '', variantName] = ref.slice(slash + 1).split('#');
    if (!usable(pid)) continue;
    const p = obj(providers[pid]);
    const key = obj(p.options).apiKey;
    if (key !== undefined && !envName(key) && !keyNoted.has(pid)) {
      keyNoted.add(pid);
      skipped.push(
        `${pid}'s API key: OpenCode's config holds it; Switchback reads keys from the environment. Put it in a variable and set the provider's apiKey to "{env:NAME}".`,
      );
    }
    const answer = translateModel(pid, mid, p, env);
    if (typeof answer === 'string') {
      if (variantName === undefined) skipped.push(`${ref}: ${answer}`);
      continue;
    }
    const m = obj(obj(p.models)[mid]);
    const variant = variantName === undefined ? undefined : variantOf(m, variantName);
    const settings = modelSettings(m, variant);
    // A variant that changes nothing, or isn't defined, is the model itself.
    if (variantName !== undefined && !settingsDiffer(settings, modelSettings(m))) {
      const same = byRef.get(`${pid}/${mid}`);
      if (same) byRef.set(ref, same);
      continue;
    }
    const full = {
      ...answer,
      ...(settings ? { settings } : {}),
      ...(variantName !== undefined ? { variant: variantName } : {}),
    };
    if ('kind' in full) remotes.push(full);
    else locals.push(full);
    byRef.set(ref, full);
    // The model comes before its variants, so a variant named as `model` wins.
    if (ref === str(cfg.model) || ref === bare(cfg.model)) current = full;
  }

  const mcpServers: Record<string, Obj> = {};
  for (const [name, raw] of Object.entries(obj(cfg.mcp))) {
    const s = obj(raw);
    if (!McpServerName.safeParse(name).success) {
      skipped.push(`MCP server "${name}": Switchback names use letters, digits, _ and - only`);
      continue;
    }
    const off = s.enabled === false ? { enabled: false } : {};
    const command = Array.isArray(s.command) ? s.command.filter((c) => typeof c === 'string') : [];
    if (s.type === 'local' && command[0]) {
      const environment = obj(s.environment);
      mcpServers[name] = {
        command: command[0],
        ...(command.length > 1 ? { args: command.slice(1) } : {}),
        ...(Object.keys(environment).length ? { env: environment } : {}),
        ...(str(s.cwd) ? { cwd: s.cwd } : {}),
        ...off,
      };
    } else if (s.type === 'remote' && str(s.url)) {
      const headers = obj(s.headers);
      mcpServers[name] = {
        url: s.url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...off,
      };
      if (Object.keys(obj(s.oauth)).length)
        skipped.push(
          `MCP server "${name}" signs in with OAuth, which Switchback doesn't do yet; give it an Authorization header`,
        );
    } else skipped.push(`MCP server "${name}": no command or URL`);
  }

  const permissions = translatePermissions(cfg, skipped);
  const agents = translateAgents(
    obj(cfg.agent),
    (ref) => byRef.get(ref) ?? byRef.get(bare(ref) ?? ''),
    Object.keys(mcpServers),
    skipped,
  );
  const compaction = translateCompaction(
    cfg,
    current && 'contextWindow' in current ? current.contextWindow : undefined,
    skipped,
  );
  for (const k of ['command', 'commands', 'skills', 'plugin', 'plugins', 'formatter', 'lsp'])
    if (
      Object.keys(obj(cfg[k])).length ||
      (Array.isArray(cfg[k]) && cfg[k].length) ||
      cfg[k] === true
    )
      skipped.push(`${k}: Switchback has its own format for these`);

  return {
    locals,
    remotes,
    ...(current ? { current } : {}),
    mcpServers,
    ...(permissions ? { permissions } : {}),
    ...(Object.keys(agents).length ? { agents } : {}),
    ...(compaction ? { compaction } : {}),
    skipped,
  };
}

/** Whether a variant's settings change anything about its model's. */
const settingsDiffer = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

const LEVELS = new Set(['allow', 'ask', 'deny']);
const isLevel = (v: unknown): v is Level => typeof v === 'string' && LEVELS.has(v);

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
function translatePermissions(cfg: Obj, skipped: string[]): ImportedPermissions | undefined {
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
