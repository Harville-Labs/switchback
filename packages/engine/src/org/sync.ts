/**
 * Keeps a running engine in step with the organization policy: fetch (with
 * ETag) on start and every `refreshSeconds`, cache it, reload config when it
 * changes, and upload usage aggregates. Failures keep the last cached policy;
 * a policy is never dropped because the server is unreachable.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerEntry } from '../ledger.ts';
import { harnessPaths } from '../paths.ts';
import { OrgAuthError, OrgClient, toAuth, type UsageAggregate } from './client.ts';
import {
  type CachedPolicy,
  type OrgAuth,
  readAuth,
  readCachedPolicy,
  writeAuth,
  writeCachedPolicy,
} from './store.ts';

type Env = Record<string, string | undefined>;

export interface RefreshResult {
  changed: boolean;
  cached?: CachedPolicy;
  error?: string;
}

/** Use the access token, refreshing it first when it's about to expire. */
async function freshAuth(
  auth: OrgAuth,
  client: OrgClient,
  env: Env,
  now: number,
): Promise<OrgAuth> {
  if (!auth.expiresAt || auth.expiresAt - now > 60_000 || !auth.refreshToken) return auth;
  const next = toAuth(auth.server, await client.refresh(auth.refreshToken), now);
  if (!env.HARNESS_ORG_TOKEN) writeAuth(next, env);
  return next;
}

/** Fetch the policy once. Safe to call when signed out (no-op). */
export async function refreshPolicy(
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<RefreshResult> {
  const auth = readAuth(env);
  if (!auth) return { changed: false };
  const client = new OrgClient(auth.server, fetchImpl);
  const cached = readCachedPolicy(env);
  try {
    const current = await freshAuth(auth, client, env, now);
    const res = await client.fetchPolicy(current.accessToken, cached?.etag);
    if (res.status === 'unchanged') return { changed: false, ...(cached ? { cached } : {}) };
    const next: CachedPolicy = {
      server: auth.server,
      fetchedAt: new Date(now).toISOString(),
      policy: res.policy,
      ...(res.etag ? { etag: res.etag } : {}),
    };
    writeCachedPolicy(next, env);
    const changed =
      !cached ||
      cached.policy.version !== next.policy.version ||
      JSON.stringify(cached.policy) !== JSON.stringify(next.policy);
    return { changed, cached: next };
  } catch (err) {
    return {
      changed: false,
      ...(cached ? { cached } : {}),
      error:
        err instanceof OrgAuthError
          ? err.message
          : `policy refresh failed: ${(err as Error).message}`,
    };
  }
}

/** Sum ledger entries per day, tier, and model. */
export function aggregateUsage(entries: LedgerEntry[]): UsageAggregate[] {
  const byKey = new Map<string, UsageAggregate>();
  for (const e of entries) {
    const date = e.ts.slice(0, 10);
    const key = [date, e.tier, e.model.provider, e.model.model].join('\u0000');
    const a = byKey.get(key) ?? {
      date,
      tier: e.tier,
      provider: e.model.provider,
      model: e.model.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    };
    a.calls++;
    a.inputTokens += e.usage.inputTokens;
    a.outputTokens += e.usage.outputTokens;
    a.cacheReadTokens += e.usage.cacheReadTokens ?? 0;
    a.costUsd += e.costUsd;
    byKey.set(key, a);
  }
  return [...byKey.values()];
}

export interface OrgSyncOptions {
  env?: Env;
  fetch?: typeof fetch;
  /** Called after a changed policy has been cached; reload config here. */
  onPolicyChanged: () => void;
  /** Ledger entries recorded after a timestamp, for usage upload. */
  usageSince?: (iso: string) => LedgerEntry[];
  onError?: (message: string) => void;
}

export class OrgSync {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private lastError: string | undefined;

  constructor(private readonly options: OrgSyncOptions) {}

  start(): void {
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One refresh-and-report cycle; also used by tests. */
  async tick(): Promise<void> {
    const env = this.options.env ?? process.env;
    const result = await refreshPolicy(env, this.options.fetch);
    if (result.changed) this.options.onPolicyChanged();
    // Report each distinct error once, not every interval.
    if (result.error && result.error !== this.lastError) this.options.onError?.(result.error);
    this.lastError = result.error;
    if (!result.error)
      await this.reportUsage(env).catch((err) => this.options.onError?.(String(err)));
    if (this.stopped) return;
    const seconds = result.cached?.policy.refreshSeconds ?? 300;
    this.timer = setTimeout(() => void this.tick(), seconds * 1000);
    this.timer.unref?.();
  }

  private async reportUsage(env: Env): Promise<void> {
    const auth = readAuth(env);
    if (!auth || !this.options.usageSince) return;
    const stateFile = join(harnessPaths(env).dataDir, 'org-usage-state.json');
    const since = existsSync(stateFile)
      ? ((JSON.parse(readFileSync(stateFile, 'utf8')) as { reportedThrough?: string })
          .reportedThrough ?? '')
      : '';
    const entries = this.options.usageSince(since);
    if (!entries.length) return;
    const accepted = await new OrgClient(auth.server, this.options.fetch).reportUsage(
      auth.accessToken,
      aggregateUsage(entries),
    );
    // A server without a usage endpoint just doesn't get reports.
    if (accepted) {
      const through = entries.reduce((max, e) => (e.ts > max ? e.ts : max), since);
      writeFileSync(stateFile, JSON.stringify({ reportedThrough: through }));
    }
  }
}
