/**
 * On-disk state for organization sign-in: credentials (config dir, 0600) and
 * the last policy received (data dir, 0600, since policies can carry
 * org-provided endpoints and keys). Both are per machine user.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TokenResponse } from '@harville-labs/switchback-org/client';
import { z } from 'zod';
import { switchbackPaths } from '../paths.ts';
import { OrgPolicy } from './policy.ts';

type Env = Record<string, string | undefined>;

export const OrgAuth = z.object({
  server: z.url(),
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  /** Epoch ms. */
  expiresAt: z.number().optional(),
  org: z.object({ id: z.string(), name: z.string() }),
  user: z.object({ email: z.string().optional(), name: z.string().optional() }).prefault({}),
});
export type OrgAuth = z.infer<typeof OrgAuth>;

/** Stored credentials. `org` comes from the token response, or the policy when it's absent. */
export function toAuth(
  server: string,
  t: TokenResponse,
  org: { id: string; name: string },
  now = Date.now(),
): OrgAuth {
  return {
    server,
    accessToken: t.access_token,
    ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
    ...(t.expires_in ? { expiresAt: now + t.expires_in * 1000 } : {}),
    org: t.org ?? org,
    user: t.user,
  };
}

export const CachedPolicy = z.object({
  server: z.string(),
  etag: z.string().optional(),
  fetchedAt: z.string(),
  policy: OrgPolicy,
});
export type CachedPolicy = z.infer<typeof CachedPolicy>;

export function orgPaths(env: Env = process.env) {
  const hp = switchbackPaths(env);
  return { auth: join(hp.configDir, 'auth.json'), policy: join(hp.dataDir, 'org-policy.json') };
}

function writePrivate(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // writeFileSync's mode only applies on create
  } catch {
    // Windows: ACLs, not modes; the file is in the user's profile.
  }
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Credentials: SWITCHBACK_ORG_SERVER + SWITCHBACK_ORG_TOKEN (CI, managed installs)
 * win over the file written by `switchback login`.
 */
export function readAuth(env: Env = process.env): OrgAuth | undefined {
  if (env.SWITCHBACK_ORG_SERVER && env.SWITCHBACK_ORG_TOKEN) {
    return {
      server: env.SWITCHBACK_ORG_SERVER,
      accessToken: env.SWITCHBACK_ORG_TOKEN,
      org: { id: env.SWITCHBACK_ORG_ID ?? 'env', name: env.SWITCHBACK_ORG_ID ?? 'organization' },
      user: {},
    };
  }
  const parsed = OrgAuth.safeParse(readJson(orgPaths(env).auth));
  return parsed.success ? parsed.data : undefined;
}

export function writeAuth(auth: OrgAuth, env: Env = process.env) {
  writePrivate(orgPaths(env).auth, auth);
}

/** Sign out: forget credentials and the cached policy. */
export function clearAuth(env: Env = process.env) {
  const p = orgPaths(env);
  rmSync(p.auth, { force: true });
  rmSync(p.policy, { force: true });
}

/** The cached policy, only if it belongs to the server the user is signed in to. */
export function readCachedPolicy(env: Env = process.env): CachedPolicy | undefined {
  const auth = readAuth(env);
  if (!auth) return undefined;
  const parsed = CachedPolicy.safeParse(readJson(orgPaths(env).policy));
  return parsed.success && parsed.data.server === auth.server ? parsed.data : undefined;
}

export function writeCachedPolicy(cached: CachedPolicy, env: Env = process.env) {
  writePrivate(orgPaths(env).policy, cached);
}
