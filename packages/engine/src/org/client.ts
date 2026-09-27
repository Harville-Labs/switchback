/**
 * Client for an organization config server. The contract (docs/organizations.md):
 *
 *   POST /v1/device/code          start device sign-in (RFC 8628 style)
 *   POST /v1/device/token         poll for the token
 *   POST /v1/token/refresh        exchange a refresh token
 *   GET  /v1/policy               the org policy (ETag / If-None-Match)
 *   POST /v1/usage                daily usage aggregates (optional endpoint)
 */
import { z } from 'zod';
import { OrgPolicy } from './policy.ts';
import type { OrgAuth } from './store.ts';

type Fetch = typeof fetch;

export class OrgAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgAuthError';
  }
}

export class OrgServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgServerError';
  }
}

const DeviceCode = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number().default(600),
  interval: z.number().default(5),
});
export type DeviceCode = z.infer<typeof DeviceCode>;

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  org: z.object({ id: z.string(), name: z.string() }),
  user: z.object({ email: z.string().optional(), name: z.string().optional() }).prefault({}),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export interface UsageAggregate {
  date: string;
  tier: 'local' | 'remote';
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export function toAuth(server: string, t: TokenResponse, now = Date.now()): OrgAuth {
  return {
    server,
    accessToken: t.access_token,
    ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
    ...(t.expires_in ? { expiresAt: now + t.expires_in * 1000 } : {}),
    org: t.org,
    user: t.user,
  };
}

export class OrgClient {
  private readonly base: string;

  constructor(
    server: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.base = server.replace(/\/+$/, '');
  }

  private async post(path: string, body: unknown, token?: string): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new OrgServerError(`cannot reach ${this.base}: ${(err as Error).message}`);
    }
  }

  async startDeviceLogin(): Promise<DeviceCode> {
    const res = await this.post('/v1/device/code', { client: 'harness' });
    if (!res.ok) throw new OrgServerError(`sign-in is not available (HTTP ${res.status})`);
    return DeviceCode.parse(await res.json());
  }

  /** One poll. Returns the token, or 'pending' / 'slow_down' to keep waiting. */
  async pollDeviceToken(deviceCode: string): Promise<TokenResponse | 'pending' | 'slow_down'> {
    const res = await this.post('/v1/device/token', { device_code: deviceCode });
    if (res.ok) return TokenResponse.parse(await res.json());
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === 'authorization_pending') return 'pending';
    if (body.error === 'slow_down') return 'slow_down';
    if (body.error === 'access_denied') throw new OrgAuthError('sign-in was denied');
    if (body.error === 'expired_token')
      throw new OrgAuthError('the sign-in code expired; run `harness login` again');
    throw new OrgServerError(
      `sign-in failed (HTTP ${res.status}${body.error ? `: ${body.error}` : ''})`,
    );
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    const res = await this.post('/v1/token/refresh', { refresh_token: refreshToken });
    if (res.status === 400 || res.status === 401)
      throw new OrgAuthError('session expired; run `harness login`');
    if (!res.ok) throw new OrgServerError(`token refresh failed (HTTP ${res.status})`);
    return TokenResponse.parse(await res.json());
  }

  /** Fetch the policy, or learn that the cached one (by ETag) is current. */
  async fetchPolicy(
    token: string,
    etag?: string,
  ): Promise<{ status: 'unchanged' } | { status: 'updated'; policy: OrgPolicy; etag?: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/v1/policy`, {
        headers: { authorization: `Bearer ${token}`, ...(etag ? { 'if-none-match': etag } : {}) },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new OrgServerError(`cannot reach ${this.base}: ${(err as Error).message}`);
    }
    if (res.status === 304) return { status: 'unchanged' };
    if (res.status === 401 || res.status === 403)
      throw new OrgAuthError('not authorized; run `harness login`');
    if (!res.ok) throw new OrgServerError(`policy fetch failed (HTTP ${res.status})`);
    const parsed = OrgPolicy.safeParse(await res.json());
    if (!parsed.success) {
      throw new OrgServerError(
        `server sent an invalid policy: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    const newTag = res.headers.get('etag') ?? undefined;
    return { status: 'updated', policy: parsed.data, ...(newTag ? { etag: newTag } : {}) };
  }

  /** Send usage aggregates. Returns false if the server doesn't accept usage. */
  async reportUsage(token: string, entries: UsageAggregate[]): Promise<boolean> {
    const res = await this.post('/v1/usage', { entries }, token);
    if (res.status === 404 || res.status === 405) return false;
    if (res.status === 401 || res.status === 403)
      throw new OrgAuthError('not authorized; run `harness login`');
    if (!res.ok) throw new OrgServerError(`usage report failed (HTTP ${res.status})`);
    return true;
  }
}
