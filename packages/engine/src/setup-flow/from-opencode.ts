/**
 * Starting from an OpenCode setup (ADR 0022): its config files, read once
 * when the person picks it during setup, turned into setup answers, MCP
 * servers, and permissions. Nothing here runs after setup; what comes over is
 * ordinary Switchback config the person sees before it's written.
 *
 * Format: opencode.ai/docs/config, /providers, /mcp-servers, /permissions
 * (checked 2026-10-20).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openCodeApi } from '@switchback/providers';
import { deepMerge, parseJsonc } from '../config.ts';
import { McpServerName } from '../mcp/config.ts';
import { ruleProblem } from '../permissions/rules.ts';
import { aliasFor, type LocalAnswer, OPENROUTER_BASE_URL, type RemoteAnswer } from '../setup.ts';

type Env = Record<string, string | undefined>;
type Level = 'allow' | 'ask' | 'deny';
type Obj = Record<string, unknown>;

/** Permissions from another agent, in Switchback's terms. */
export interface ImportedPermissions {
  levels: Partial<Record<'read' | 'edit' | 'bash' | 'web' | 'mcp', Level>>;
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

const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

/** `{env:NAME}` → `NAME`; anything else isn't an environment reference. */
const envName = (v: unknown) => /^\{env:([A-Za-z0-9_]+)\}$/.exec(str(v) ?? '')?.[1];

/** Translate a merged OpenCode config. */
export function fromOpenCode(cfg: Obj, env: Env = process.env): Omit<Imported, 'files'> {
  const skipped: string[] = [];
  const providers = obj(cfg.provider);
  const disabled = new Set(Array.isArray(cfg.disabled_providers) ? cfg.disabled_providers : []);
  const enabled = Array.isArray(cfg.enabled_providers) ? new Set(cfg.enabled_providers) : undefined;
  const usable = (pid: string) => !disabled.has(pid) && (!enabled || enabled.has(pid));

  // Models in the order they matter: the main model, the small one, agents',
  // then every model a custom endpoint lists.
  const refs: string[] = [];
  const add = (ref: unknown) => {
    const r = str(ref);
    if (r?.includes('/') && !refs.includes(r)) refs.push(r);
  };
  add(cfg.model);
  add(cfg.small_model);
  for (const agent of Object.values(obj(cfg.agent))) add(obj(agent).model);
  for (const [pid, p] of Object.entries(providers))
    if (str(obj(obj(p).options).baseURL))
      for (const mid of Object.keys(obj(obj(p).models))) add(`${pid}/${mid}`);

  const locals: LocalAnswer[] = [];
  const remotes: RemoteAnswer[] = [];
  let current: LocalAnswer | RemoteAnswer | undefined;
  const keyNoted = new Set<string>();
  for (const ref of refs) {
    const slash = ref.indexOf('/');
    const pid = ref.slice(0, slash);
    const mid = ref.slice(slash + 1);
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
      skipped.push(`${ref}: ${answer}`);
      continue;
    }
    if ('kind' in answer) remotes.push(answer);
    else locals.push(answer);
    if (ref === cfg.model) current = answer;
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
  for (const k of ['agent', 'command', 'plugin', 'formatter', 'lsp'])
    if (cfg[k] !== undefined && cfg[k] !== false)
      skipped.push(`${k}: Switchback has its own format for these`);

  return {
    locals,
    remotes,
    ...(current ? { current } : {}),
    mcpServers,
    ...(permissions ? { permissions } : {}),
    skipped,
  };
}

/** Packages that speak the OpenAI API, which is how Switchback reaches a custom endpoint. */
const OPENAI_SHAPED = new Set([undefined, '@ai-sdk/openai-compatible', '@ai-sdk/openai']);

/** One OpenCode model as a setup answer, or why it can't be one. */
function translateModel(
  pid: string,
  mid: string,
  p: Obj,
  env: Env,
): LocalAnswer | RemoteAnswer | string {
  const opts = obj(p.options);
  const m = obj(obj(p.models)[mid]);
  const limit = obj(m.limit);
  const contextWindow = num(limit.context);
  const baseUrl = str(opts.baseURL)?.replace(/\/+$/, '');
  const apiKeyEnv = envName(opts.apiKey);

  if (baseUrl) {
    const npm = str(p.npm);
    if (!OPENAI_SHAPED.has(npm))
      return `${npm} at a custom URL; Switchback reaches custom endpoints as OpenAI-compatible APIs`;
    if (!URL.canParse(baseUrl)) return `"${baseUrl}" isn't a URL`;
    if (isLocalHost(baseUrl))
      return {
        providerId: aliasFor(pid),
        baseUrl,
        model: mid,
        ...(contextWindow ? { contextWindow } : {}),
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
      };
    const cost = obj(m.cost);
    const price =
      typeof cost.input === 'number' && typeof cost.output === 'number'
        ? { input: cost.input, output: cost.output }
        : undefined;
    return {
      kind: 'openai-compatible',
      model: mid,
      baseUrl,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(num(limit.output) ? { maxOutputTokens: num(limit.output) } : {}),
      ...(price ? { price } : {}),
    };
  }

  switch (pid) {
    case 'anthropic':
    case 'openai':
    case 'deepseek':
      return { kind: pid, model: mid };
    case 'google':
      return { kind: 'gemini', model: mid };
    case 'openrouter':
      return {
        kind: 'openrouter',
        model: mid,
        baseUrl: OPENROUTER_BASE_URL,
        apiKeyEnv: apiKeyEnv ?? 'OPENROUTER_API_KEY',
        ...(contextWindow ? { contextWindow } : {}),
      };
    case 'opencode':
    case 'opencode-go':
      if (!openCodeApi(mid))
        return "OpenCode serves it on Google's API, which Switchback doesn't use through OpenCode";
      return {
        kind: 'opencode',
        plan: pid === 'opencode' ? 'zen' : 'go',
        model: mid,
        ...(contextWindow ? { contextWindow } : {}),
      };
    case 'amazon-bedrock': {
      // Switchback adds the `anthropic.` prefix itself; cross-region prefixes aren't catalog IDs.
      const bare = mid.replace(/^(?:(?:us|eu|apac|jp|au|global)\.)?anthropic\./, '');
      if (!bare.startsWith('claude-')) return 'Switchback uses Bedrock for Claude models only';
      return {
        kind: 'bedrock',
        model: bare,
        region: str(opts.region) ?? env.AWS_REGION ?? 'us-east-1',
        ...(str(opts.profile) ? { profile: opts.profile as string } : {}),
      };
    }
    case 'google-vertex-anthropic': {
      const projectId =
        str(opts.project) ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCP_PROJECT ?? env.GCLOUD_PROJECT;
      if (!projectId) return 'no Google Cloud project in the config or GOOGLE_CLOUD_PROJECT';
      return {
        kind: 'vertex',
        // Vertex pins versions with `@date`; Switchback's IDs have none.
        model: mid.replace(/@.*$/, ''),
        projectId,
        region: str(opts.location) ?? env.VERTEX_LOCATION ?? 'global',
      };
    }
    case 'azure': {
      const resource = str(opts.resourceName) ?? env.AZURE_RESOURCE_NAME;
      if (!resource) return 'no Azure resource name in the config or AZURE_RESOURCE_NAME';
      // OpenCode needs the deployment named after the model.
      return { kind: 'azure-openai', model: mid, deployment: mid, resource };
    }
    default:
      return `Switchback has no "${pid}" provider; add it in the next step if it serves an OpenAI-compatible API`;
  }
}

/** Loopback, private networks, `.local`, and bare hostnames: a server on this machine or LAN. */
export function isLocalHost(url: string): boolean {
  const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h === '::1' ||
    h.endsWith('.local') ||
    /^(127|10)\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    (!h.includes('.') && !h.includes(':'))
  );
}

const LEVELS = new Set(['allow', 'ask', 'deny']);
const isLevel = (v: unknown): v is Level => typeof v === 'string' && LEVELS.has(v);
const STRICTNESS: Level[] = ['allow', 'ask', 'deny'];
const stricter = (a: Level | undefined, b: Level) =>
  a && STRICTNESS.indexOf(a) > STRICTNESS.indexOf(b) ? a : b;

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
  }

  const perm = cfg.permission;
  if (isLevel(perm))
    for (const k of ['read', 'edit', 'bash', 'web', 'mcp'] as const) out.levels[k] = perm;
  const table = obj(perm);
  const all = table['*'];
  if (isLevel(all))
    for (const k of ['read', 'edit', 'bash', 'web', 'mcp'] as const) out.levels[k] ??= all;

  const ignored: string[] = [];
  for (const [tool, value] of Object.entries(table)) {
    if (tool === '*') continue;
    const target =
      tool === 'shell' || tool === 'bash'
        ? 'bash'
        : tool === 'read' || tool === 'edit'
          ? tool
          : tool === 'webfetch' || tool === 'websearch'
            ? 'web'
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
        out.levels[target] = target === 'web' ? stricter(out.levels.web, level) : level;
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
