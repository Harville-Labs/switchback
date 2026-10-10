/**
 * Client for an organization config server. The contract (docs/organizations.md):
 *
 *   POST /v1/device/code   device authorization endpoint (RFC 8628)
 *   POST /v1/token         token endpoint (RFC 6749): device code and refresh grants
 *   GET  /v1/policy        the org policy (ETag / If-None-Match)
 *   POST /v1/usage         daily usage aggregates (optional endpoint)
 *
 * Sign-in and refresh use openid-client, which implements the OAuth grants,
 * polling, and `slow_down` handling; this file only maps its errors.
 */
import * as oidc from 'openid-client';
import { z } from 'zod';
import { OrgPolicy } from './policy.ts';

type Fetch = typeof fetch;

/** The OAuth client ID Switchback presents to every organization server. */
export const CLIENT_ID = 'switchback';

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

/** A started device sign-in: what to show, and what openid-client polls with. */
export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  response: oidc.DeviceAuthorizationResponse;
}

/** RFC 6749 token response, plus the org and account the server may name (ADR 0007). */
const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  org: z.object({ id: z.string(), name: z.string() }).optional(),
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

/** openid-client's errors, as the two kinds callers act on. */
function mapError(err: unknown, base: string): never {
  if (err instanceof oidc.ResponseBodyError) {
    if (err.error === 'access_denied') throw new OrgAuthError('sign-in was denied');
    if (err.error === 'expired_token')
      throw new OrgAuthError('the sign-in code expired; run `switchback login` again');
    if (err.error === 'invalid_grant' || err.status === 401)
      throw new OrgAuthError(
        err.error_description
          ? `${err.error_description}; run \`switchback login\``
          : 'session expired; run `switchback login`',
      );
    throw new OrgServerError(
      `sign-in failed (HTTP ${err.status}: ${err.error}${err.error_description ? `, ${err.error_description}` : ''})`,
    );
  }
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    throw new OrgAuthError('the sign-in code expired; run `switchback login` again');
  // openid-client rejects responses that break the OAuth specs with a ClientError;
  // a failed request surfaces as the fetch's own TypeError.
  if (err instanceof oidc.ClientError) {
    const detail = err.cause instanceof Error ? `: ${err.cause.message}` : '';
    throw new OrgServerError(`${base} sent an invalid sign-in response (${err.message}${detail})`);
  }
  throw new OrgServerError(`cannot reach ${base}: ${(err as Error).message}`);
}

export class OrgClient {
  private readonly base: string;
  private readonly oauth: oidc.Configuration;

  constructor(
    server: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.base = server.replace(/\/+$/, '');
    this.oauth = new oidc.Configuration(
      {
        issuer: this.base,
        device_authorization_endpoint: `${this.base}/v1/device/code`,
        token_endpoint: `${this.base}/v1/token`,
      },
      CLIENT_ID,
      undefined,
      oidc.None(),
    );
    // openid-client sets its own request timeout; its body types are a subset of fetch's.
    // OAuth requests are form posts (RFC 6749), which web frameworks' CSRF checks
    // (SvelteKit's among them) refuse without a same-origin Origin header. Browsers
    // are what that check guards against; a CLI saying where it's posting is harmless.
    const origin = new URL(this.base).origin;
    this.oauth[oidc.customFetch] = (url, options) => {
      const headers = new Headers(options.headers);
      headers.set('origin', origin);
      return this.fetchImpl(url, { ...(options as RequestInit), headers });
    };
    // Local development servers (`switchback login --server http://localhost:…`).
    if (this.base.startsWith('http://')) oidc.allowInsecureRequests(this.oauth);
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

  async startDeviceLogin(): Promise<DeviceLogin> {
    try {
      const response = await oidc.initiateDeviceAuthorization(this.oauth, {});
      return {
        userCode: response.user_code,
        verificationUri: response.verification_uri,
        ...(response.verification_uri_complete
          ? { verificationUriComplete: response.verification_uri_complete }
          : {}),
        expiresIn: response.expires_in,
        response,
      };
    } catch (err) {
      mapError(err, this.base);
    }
  }

  /** Poll until the person approves or denies, or the code expires. */
  async waitForDeviceToken(login: DeviceLogin, signal?: AbortSignal): Promise<TokenResponse> {
    try {
      const tokens = await oidc.pollDeviceAuthorizationGrant(
        this.oauth,
        login.response,
        undefined,
        signal ? { signal } : undefined,
      );
      return TokenResponse.parse(tokens);
    } catch (err) {
      mapError(err, this.base);
    }
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    try {
      return TokenResponse.parse(await oidc.refreshTokenGrant(this.oauth, refreshToken));
    } catch (err) {
      mapError(err, this.base);
    }
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
      throw new OrgAuthError('not authorized; run `switchback login`');
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
      throw new OrgAuthError('not authorized; run `switchback login`');
    if (!res.ok) throw new OrgServerError(`usage report failed (HTTP ${res.status})`);
    return true;
  }
}
