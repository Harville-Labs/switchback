/** `switchback login | logout | whoami`: organization sign-in and policy status. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  adoptOrgPermissions,
  clearAuth,
  loadConfig,
  OrgAuthError,
  OrgClient,
  type OrgPolicy,
  OrgServerError,
  readAuth,
  readCachedPolicy,
  switchbackPaths,
  toAuth,
  writeAuth,
  writeCachedPolicy,
} from '@switchback/engine';
import { bold, dim, green, yellow } from '../prompt.ts';

export interface LoginFlags {
  cwd: string;
  server?: string;
  /** A Harville Labs site ID: shorthand for its server URL (ADR 0010). */
  site?: string;
  token?: string;
}

/** Where Harville Labs hosts sites; `SWITCHBACK_SITES_URL` points elsewhere (staging, tests). */
export function siteServer(site: string, env = process.env): string {
  const base = (env.SWITCHBACK_SITES_URL ?? 'https://app.switchback.sh').replace(/\/+$/, '');
  return `${base}/sites/${encodeURIComponent(site)}`;
}

function openBrowser(url: string) {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // No browser; the URL is printed anyway.
  }
}

export function describeRestrictions(policy: OrgPolicy): string[] {
  const r = policy.restrictions;
  const lines: string[] = [];
  if (!r.allowRemote) lines.push('remote models disabled: everything runs locally');
  if (r.allowedProviderTypes)
    lines.push(`allowed provider types: ${r.allowedProviderTypes.join(', ')}`);
  if (!r.allowUserProviders) lines.push('only organization-defined providers');
  if (!r.allowUserPermissions) lines.push('permissions set by the organization only');
  if (!r.allowBypassPermissions) lines.push('bypassPermissions mode disabled');
  if (r.maxDailyUsd) lines.push(`remote spend capped at $${r.maxDailyUsd}/day`);
  if (r.maxMonthlyUsd) lines.push(`remote spend capped at $${r.maxMonthlyUsd}/month`);
  const enforced = Object.keys(policy.enforced);
  if (enforced.length) lines.push(`enforced settings: ${enforced.join(', ')}`);
  return lines;
}

export async function login(flags: LoginFlags): Promise<number> {
  if (flags.site && flags.server) {
    console.error('switchback login: pass --site or --server, not both');
    return 2;
  }
  const server = (
    (flags.site ? siteServer(flags.site) : flags.server) ??
    readAuth()?.server ??
    process.env.SWITCHBACK_ORG_SERVER
  )?.replace(/\/+$/, '');
  if (!server) {
    console.error(
      'switchback login: pass --site <id> (your company’s Switchback site) or --server <url>',
    );
    return 2;
  }
  const client = new OrgClient(server);
  try {
    let auth: ReturnType<typeof toAuth>;
    let policy: OrgPolicy;
    if (flags.token) {
      // Personal/CI token: validate it by fetching the policy, which names the org.
      const res = await client.fetchPolicy(flags.token);
      if (res.status !== 'updated') throw new OrgServerError('server returned no policy');
      policy = res.policy;
      auth = { server, accessToken: flags.token, org: policy.org, user: {} };
      writeCachedPolicy({
        server,
        fetchedAt: new Date().toISOString(),
        policy,
        ...(res.etag ? { etag: res.etag } : {}),
      });
    } else {
      const code = await client.startDeviceLogin();
      const url = code.verificationUriComplete ?? code.verificationUri;
      console.log(
        `${bold('Sign in to your organization')}\n  Open ${url}\n  and confirm the code ${bold(code.userCode)}\n`,
      );
      openBrowser(url);
      const token = await client.waitForDeviceToken(code);
      const res = await client.fetchPolicy(token.access_token);
      if (res.status !== 'updated') throw new OrgServerError('server returned no policy');
      policy = res.policy;
      auth = toAuth(server, token, policy.org);
      writeCachedPolicy({
        server,
        fetchedAt: new Date().toISOString(),
        policy,
        ...(res.etag ? { etag: res.etag } : {}),
      });
    }
    writeAuth(auth);
    // Only usage from now on is reported to the organization.
    writeFileSync(
      join(switchbackPaths().dataDir, 'org-usage-state.json'),
      JSON.stringify({ reportedThrough: new Date().toISOString() }),
    );

    console.log(
      `${green('✓')} Signed in to ${bold(policy.org.name)}${auth.user.email ? ` as ${auth.user.email}` : ''}`,
    );
    const adopted = adoptOrgPermissions(switchbackPaths().configFile, policy);
    if (adopted)
      console.log(
        `  Your permissions are now ${policy.org.name}'s, in ${adopted.file}${adopted.backup ? dim(` (previous version: ${adopted.backup})`) : ''}${policy.restrictions.allowUserPermissions ? '; you can edit them' : ''}`,
      );
    const lines = describeRestrictions(policy);
    console.log(
      lines.length
        ? lines.map((l) => `  ${l}`).join('\n')
        : dim('  no restrictions in the current policy'),
    );
    return 0;
  } catch (err) {
    if (err instanceof OrgAuthError || err instanceof OrgServerError) {
      console.error(`switchback login: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

export function logout(): number {
  const auth = readAuth();
  if (process.env.SWITCHBACK_ORG_TOKEN) {
    console.error('switchback logout: signed in through SWITCHBACK_ORG_TOKEN; unset it instead');
    return 2;
  }
  clearAuth();
  console.log(
    auth ? `Signed out of ${auth.org.name}. Its policy no longer applies.` : 'Not signed in.',
  );
  return 0;
}

export function whoami(cwd: string): number {
  const auth = readAuth();
  if (!auth) {
    console.log(
      'Not signed in to an organization. `switchback login --site <id>` (or `--server <url>`) to sign in.',
    );
    return 0;
  }
  const cached = readCachedPolicy();
  console.log(`${bold(auth.org.name)} (${auth.org.id}) at ${auth.server}`);
  if (auth.user.email) console.log(`  user ${auth.user.email}`);
  if (!cached) {
    console.log(yellow('  no policy received yet; it applies once the server is reachable'));
    return 0;
  }
  console.log(`  policy revision ${cached.policy.version}, fetched ${cached.fetchedAt}`);
  for (const l of describeRestrictions(cached.policy)) console.log(`  ${l}`);
  const loaded = loadConfig(cwd);
  for (const n of loaded.org?.notes ?? []) console.log(`  ${dim(n)}`);
  return 0;
}
