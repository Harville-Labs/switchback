/**
 * Opt-in, anonymous usage telemetry (docs/telemetry.md).
 *
 * Off unless the user turns it on. Nothing is collected while it's off: the
 * counters file is written only when enabled, and daily reports cover only
 * days after the user opted in. A report is built from the usage ledger and a
 * few counters, and holds counts, token totals, and dollar amounts, plus names
 * Harness itself defines (routing rules, provider types, catalog model IDs).
 * It never holds prompts, code, file names, paths, agent or model aliases,
 * provider IDs, or server URLs. `harness telemetry preview` prints exactly
 * what would be sent.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { EngineEvent, StopReason } from '@harness/protocol';
import { CATALOG } from '@harness/providers';
import { z } from 'zod';
import type { HarnessConfig } from './config.ts';
import type { LedgerEntry } from './ledger.ts';

export const TELEMETRY_SCHEMA = 1;
export const DEFAULT_TELEMETRY_ENDPOINT = 'https://harness.harville.ai/api/telemetry/v1';

/** Routing rules Harness defines; anything else is reported as `other`. */
const KNOWN_RULES = new Set([
  'refusal-fallback',
  'user-override',
  'escalation-declined',
  'mode',
  'agent-pin',
  'context-overflow',
  'sticky',
  'classifier',
  'escalation',
  'default',
  'context-fit',
  'fallback',
  'agent-budget',
  'budget',
  'privacy',
  'classify',
  'compaction',
  'runtime',
  'authoring',
  'review',
]);

/** Public model IDs from the catalog; everything else (local models, custom names) is `custom`. */
const KNOWN_MODELS = new Set(Object.values(CATALOG).flatMap((c) => c.models.map((m) => m.id)));

/** A catalog model ID (Bedrock's `anthropic.` prefix removed), or `custom`. */
function publicModel(model: string): string {
  const bare = model.replace(/^(?:[a-z]+\.)?anthropic\./, '');
  return KNOWN_MODELS.has(bare) ? bare : 'custom';
}

export const DailyReport = z.object({
  schema: z.literal(TELEMETRY_SCHEMA),
  installId: z.string(),
  day: z.string(),
  version: z.string(),
  os: z.string(),
  arch: z.string(),
  calls: z.object({ local: z.number(), remote: z.number() }),
  tokens: z.object({
    local: z.object({ input: z.number(), output: z.number() }),
    remote: z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
  }),
  /** Remote spend, estimated savings, and what running it all remote would have cost. */
  costUsd: z.number(),
  savingsUsd: z.number(),
  allRemoteUsd: z.number(),
  byRule: z.record(
    z.string(),
    z.object({ local: z.number(), remote: z.number(), costUsd: z.number() }),
  ),
  /** Remote calls per catalog model ID (`custom` for anything else). */
  remoteModels: z.record(z.string(), z.number()),
  /** Configured provider types, e.g. `ollama`, `anthropic`; never IDs or URLs. */
  providerTypes: z.array(z.string()),
  features: z.object({
    localModels: z.number(),
    remoteModels: z.number(),
    escalationPolicy: z.string(),
    classifier: z.boolean(),
    compaction: z.boolean(),
    privatePaths: z.boolean(),
    secrets: z.string(),
    mcpServers: z.number(),
    runtimes: z.number(),
    budget: z.boolean(),
    organization: z.boolean(),
  }),
  /** How top-level turns ended. */
  turns: z.record(z.string(), z.number()),
  errors: z.number(),
  crashes: z.array(z.object({ name: z.string(), message: z.string(), stack: z.string() })),
});
export type DailyReport = z.infer<typeof DailyReport>;

// ---------------------------------------------------------------------------
// State and counters (data directory)
// ---------------------------------------------------------------------------

export interface TelemetryState {
  installId: string;
  /** When the user opted in; nothing earlier is ever reported. */
  enabledAt: string;
  /** Last day reported successfully (YYYY-MM-DD). */
  sentThrough?: string;
}

type Counter =
  | { ts: string; kind: 'turn'; stopReason: StopReason }
  | { ts: string; kind: 'error' }
  | { ts: string; kind: 'crash'; name: string; message: string; stack: string };

export function telemetryPaths(dataDir: string) {
  return {
    state: join(dataDir, 'telemetry.json'),
    counters: join(dataDir, 'telemetry-counters.jsonl'),
  };
}

export function readTelemetryState(dataDir: string): TelemetryState | undefined {
  const file = telemetryPaths(dataDir).state;
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as TelemetryState;
  } catch {
    return undefined;
  }
}

export function writeTelemetryState(dataDir: string, state: TelemetryState): void {
  const file = telemetryPaths(dataDir).state;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Opt in: a fresh anonymous install ID the first time, and a new start date. */
export function optIn(dataDir: string, now: Date): TelemetryState {
  const prev = readTelemetryState(dataDir);
  const state: TelemetryState = {
    installId: prev?.installId ?? crypto.randomUUID(),
    enabledAt: now.toISOString(),
    ...(prev?.sentThrough ? { sentThrough: prev.sentThrough } : {}),
  };
  writeTelemetryState(dataDir, state);
  return state;
}

/** Opt out: forget the counters. The install ID stays so a later opt-in is one install. */
export function optOut(dataDir: string): void {
  const { counters } = telemetryPaths(dataDir);
  if (existsSync(counters)) writeFileSync(counters, '');
}

function appendCounter(dataDir: string, c: Counter): void {
  const file = telemetryPaths(dataDir).counters;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(c)}\n`, { mode: 0o600 });
}

function readCounters(dataDir: string): Counter[] {
  const file = telemetryPaths(dataDir).counters;
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l) as Counter] : [];
      } catch {
        return [];
      }
    });
}

/** Count what telemetry reports about an engine's turns (top-level sessions only). */
export function recordEngineEvent(dataDir: string, event: EngineEvent, now: Date): void {
  if (event.type === 'log' || event.type === 'config.updated' || event.parentSessionId) return;
  if (event.type === 'turn.completed')
    appendCounter(dataDir, { ts: now.toISOString(), kind: 'turn', stopReason: event.stopReason });
  else if (event.type === 'error') appendCounter(dataDir, { ts: now.toISOString(), kind: 'error' });
}

/**
 * Remove anything that could identify a user or their code from an error:
 * paths, quoted strings, URLs, long numbers, and anything after 200
 * characters. Stack frames keep only function names and Harness's own file
 * names.
 */
export function scrubError(err: unknown): { name: string; message: string; stack: string } {
  const e = err instanceof Error ? err : new Error(String(err));
  const scrub = (s: string) =>
    s
      .replace(/[a-z]+:\/\/\S+/gi, '<url>')
      .replace(/(["'`]).*?\1/g, '<str>')
      .replace(/(?:[A-Za-z]:)?[\\/][^\s:()'"]+/g, '<path>')
      .replace(/\d{4,}/g, '<n>');
  const frames = (e.stack ?? '')
    .split('\n')
    .slice(1, 12)
    .map((l) => {
      const fn = /at (?:async )?([\w$.<>]+) \(/.exec(l)?.[1] ?? '<anonymous>';
      const file = /[\\/](packages|apps)[\\/](.+?\.tsx?):(\d+)/.exec(l);
      return `at ${fn}${file ? ` (${file[1]}/${file[2]?.replaceAll('\\', '/')}:${file[3]})` : ''}`;
    });
  return {
    name: /^\w+$/.test(e.name) ? e.name : 'Error',
    message: scrub(e.message).slice(0, 200),
    stack: frames.join('\n'),
  };
}

/** Record a crash for the next report (only while telemetry is on). */
export function recordCrash(dataDir: string, err: unknown, now: Date): void {
  appendCounter(dataDir, { ts: now.toISOString(), kind: 'crash', ...scrubError(err) });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function features(config: HarnessConfig, organization: boolean): DailyReport['features'] {
  const tierCount = (tier: 'local' | 'remote') =>
    config.routing[tier].filter((a) => config.models[a]).length;
  return {
    localModels: tierCount('local'),
    remoteModels: tierCount('remote'),
    escalationPolicy: config.routing.escalation.policy,
    classifier: !!config.routing.classifier,
    compaction: config.compaction.enabled,
    privatePaths: config.privacy.localOnlyPaths.length > 0,
    secrets: config.privacy.secrets,
    mcpServers: Object.keys(config.mcpServers).length,
    runtimes: Object.keys(config.runtimes).length,
    budget:
      config.routing.budget.dailyUsd !== undefined ||
      config.routing.budget.monthlyUsd !== undefined,
    organization,
  };
}

/** Complete days (before `today`) that are due: after opt-in and after the last one sent. */
export function dueDays(state: TelemetryState, today: string, max = 30): string[] {
  const start = state.enabledAt.slice(0, 10);
  const days: string[] = [];
  const d = new Date(`${today}T00:00:00Z`);
  for (let i = 1; i <= max; i++) {
    const day = new Date(d.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    if (day < start || (state.sentThrough && day <= state.sentThrough)) break;
    days.unshift(day);
  }
  return days;
}

export interface ReportInput {
  state: TelemetryState;
  config: HarnessConfig;
  organization: boolean;
  version: string;
  ledger: LedgerEntry[];
  counters: Counter[];
  day: string;
}

export function buildReport(input: ReportInput): DailyReport {
  const { day, state } = input;
  // Only what happened after opting in, even on the opt-in day.
  const since = state.enabledAt;
  const entries = input.ledger.filter((e) => e.ts.startsWith(day) && e.ts >= since);
  const counters = input.counters.filter((c) => c.ts.startsWith(day) && c.ts >= since);
  const r: DailyReport = {
    schema: TELEMETRY_SCHEMA,
    installId: state.installId,
    day,
    version: input.version,
    os: platform(),
    arch: arch(),
    calls: { local: 0, remote: 0 },
    tokens: {
      local: { input: 0, output: 0 },
      remote: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    costUsd: 0,
    savingsUsd: 0,
    allRemoteUsd: 0,
    byRule: {},
    remoteModels: {},
    providerTypes: [...new Set(Object.values(input.config.providers).map((p) => p.type))].sort(),
    features: features(input.config, input.organization),
    turns: {},
    errors: 0,
    crashes: [],
  };
  for (const e of entries) {
    r.calls[e.tier]++;
    const u = e.usage;
    if (e.tier === 'local') {
      r.tokens.local.input += u.inputTokens + (u.cacheReadTokens ?? 0);
      r.tokens.local.output += u.outputTokens;
    } else {
      r.tokens.remote.input += u.inputTokens;
      r.tokens.remote.output += u.outputTokens;
      r.tokens.remote.cacheRead += u.cacheReadTokens ?? 0;
      r.tokens.remote.cacheWrite += u.cacheWriteTokens ?? 0;
      const model = publicModel(e.model.model);
      r.remoteModels[model] = (r.remoteModels[model] ?? 0) + 1;
    }
    r.costUsd += e.costUsd;
    r.savingsUsd += e.savingsUsd;
    const rule = e.rule && KNOWN_RULES.has(e.rule) ? e.rule : 'other';
    const row = r.byRule[rule] ?? { local: 0, remote: 0, costUsd: 0 };
    row[e.tier]++;
    row.costUsd += e.costUsd;
    r.byRule[rule] = row;
  }
  r.allRemoteUsd = r.costUsd + r.savingsUsd;
  for (const c of counters) {
    if (c.kind === 'turn') r.turns[c.stopReason] = (r.turns[c.stopReason] ?? 0) + 1;
    else if (c.kind === 'error') r.errors++;
    else if (r.crashes.length < 5)
      r.crashes.push({ name: c.name, message: c.message, stack: c.stack });
  }
  return r;
}

export interface TelemetryContext {
  dataDir: string;
  config: HarnessConfig;
  organization: boolean;
  version: string;
  ledger: LedgerEntry[];
  now: Date;
}

/** Reports due now (complete days since opt-in, not yet sent). */
export function pendingReports(ctx: TelemetryContext): DailyReport[] {
  const state = readTelemetryState(ctx.dataDir);
  if (!state) return [];
  const counters = readCounters(ctx.dataDir);
  return dueDays(state, ctx.now.toISOString().slice(0, 10)).map((day) =>
    buildReport({ ...ctx, state, counters, day }),
  );
}

/** Today's report so far (sent once the day is over), for `harness telemetry preview`. */
export function todaysReport(ctx: TelemetryContext): DailyReport | undefined {
  const state = readTelemetryState(ctx.dataDir);
  if (!state) return undefined;
  return buildReport({
    ...ctx,
    state,
    counters: readCounters(ctx.dataDir),
    day: ctx.now.toISOString().slice(0, 10),
  });
}

/**
 * Send due reports. Failures are silent (telemetry must never get in the
 * way) and retried next time; after a success the counters that were
 * reported are dropped.
 */
export async function sendTelemetry(
  ctx: TelemetryContext,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<{ sent: number; error?: string }> {
  if (!ctx.config.telemetry.enabled) return { sent: 0 };
  const state = readTelemetryState(ctx.dataDir);
  const reports = pendingReports(ctx);
  if (!state || !reports.length) return { sent: 0 };
  try {
    const res = await fetchImpl(ctx.config.telemetry.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reports }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { sent: 0, error: `HTTP ${res.status}` };
  } catch (err) {
    return { sent: 0, error: (err as Error).message };
  }
  const last = reports.at(-1)?.day as string;
  writeTelemetryState(ctx.dataDir, { ...state, sentThrough: last });
  const keep = readCounters(ctx.dataDir).filter((c) => c.ts.slice(0, 10) > last);
  writeFileSync(
    telemetryPaths(ctx.dataDir).counters,
    keep.map((c) => `${JSON.stringify(c)}\n`).join(''),
  );
  return { sent: reports.length };
}
