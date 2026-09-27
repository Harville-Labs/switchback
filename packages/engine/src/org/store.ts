/**
 * On-disk state for organization sign-in: credentials (config dir, 0600) and
 * the last policy received (data dir, 0600, since policies can carry
 * org-provided endpoints and keys). Both are per machine user.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { harnessPaths } from '../paths.ts';
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

export const CachedPolicy = z.object({
  server: z.string(),
  etag: z.string().optional(),
  fetchedAt: z.string(),
  policy: OrgPolicy,
});
export type CachedPolicy = z.infer<typeof CachedPolicy>;

export function orgPaths(env: Env = process.env) {
  const hp = harnessPaths(env);
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
 * Credentials: HARNESS_ORG_SERVER + HARNESS_ORG_TOKEN (CI, managed installs)
 * win over the file written by `harness login`.
 */
export function readAuth(env: Env = process.env): OrgAuth | undefined {
  if (env.HARNESS_ORG_SERVER && env.HARNESS_ORG_TOKEN) {
    return {
      server: env.HARNESS_ORG_SERVER,
      accessToken: env.HARNESS_ORG_TOKEN,
      org: { id: env.HARNESS_ORG_ID ?? 'env', name: env.HARNESS_ORG_ID ?? 'organization' },
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
