import { afterEach, beforeEach, describe as bunDescribe, expect, test } from 'bun:test';
import { OrgAuthError, OrgClient } from '@harness/engine';
import postgres from 'postgres';
import * as api from './api.ts';
import type { SiteApp } from './context.ts';
import { type Database, openDatabase } from './db.ts';
import { MemoryMailer } from './email.ts';
import * as m from './model.ts';

/**
 * These run against a real Postgres: `bun run db:up`, then `bun run test` in
 * apps/site (CI provides one). Without TEST_DATABASE_URL they're skipped.
 * The database is wiped before every test, so never point this at real data.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB)
  console.warn('site tests skipped: set TEST_DATABASE_URL (see apps/site/package.json `test`)');
const describe = TEST_DB ? bunDescribe : bunDescribe.skip;

async function resetDatabase(url: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    'drop schema if exists drizzle cascade; drop schema public cascade; create schema public;',
  );
  await sql.end();
}

const BASE = 'https://harness.test';
let database: Database;
let app: SiteApp;
let clock: number;
let ops: m.User;

beforeEach(async () => {
  if (!TEST_DB) return;
  await resetDatabase(TEST_DB);
  database = await openDatabase(TEST_DB);
  clock = Date.parse('2026-09-28T12:00:00Z');
  app = {
    ctx: { db: database.db, now: () => new Date(clock) },
    mailer: new MemoryMailer(),
    publicUrl: BASE,
  };
  ops = await m.ensureUser(app.ctx, 'ops@harville.ai', true);
});
afterEach(() => database?.close());

/** The client protocol routes, as `fetch` sees them. */
const clientFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init);
  const path = new URL(req.url).pathname;
  if (path === '/api/telemetry/v1') return api.anonymousTelemetry(app, req);
  const match = /^\/s\/([^/]+)\/v1\/(.+)$/.exec(path);
  const routes: Record<string, ReturnType<typeof api.forSite>> = {
    'device/code': api.deviceCode,
    'device/token': api.deviceToken,
    'token/refresh': api.tokenRefresh,
    policy: api.policy,
    usage: api.usage,
    telemetry: api.siteTelemetry,
  };
  const handler = match && routes[match[2] as string];
  return handler
    ? handler(app, match?.[1] as string, req)
    : new Response('not found', { status: 404 });
}) as typeof fetch;

async function acme(seats = 3) {
  const site = await m.createSite(app.ctx, ops, {
    slug: 'acme',
    name: 'Acme Corp',
    seats,
    ownerEmail: 'owner@acme.com',
  });
  const owner = await signIn('owner@acme.com');
  return { site, owner, ownerM: await m.membership(app.ctx, site, owner) };
}

async function signIn(email: string) {
  const token = await m.createLoginLink(app.ctx, email);
  return (await m.redeemLoginLink(app.ctx, token)).user;
}

async function member(site: m.Site, owner: m.User, email: string, role: m.Role = 'member') {
  await m.invite(app.ctx, site, owner, await m.membership(app.ctx, site, owner), email, role);
  const user = await signIn(email);
  return { user, m: await m.membership(app.ctx, site, user) };
}

describe('sign-in links and sessions', () => {
  test('a link works once, then gives a session; invitations become active', async () => {
    const { site } = await acme();
    const token = await m.createLoginLink(app.ctx, 'owner@acme.com', '/s/acme/');
    const r = await m.redeemLoginLink(app.ctx, token);
    expect(r.next).toBe('/s/acme/');
    expect((await m.sessionUser(app.ctx, r.session))?.email).toBe('owner@acme.com');
    await expect(m.redeemLoginLink(app.ctx, token)).rejects.toThrow('already used');
    expect((await m.membership(app.ctx, site, r.user))?.status).toBe('active');
    await m.endSession(app.ctx, r.session);
    expect(await m.sessionUser(app.ctx, r.session)).toBeUndefined();
  });

  test('links expire after 15 minutes; sessions after two weeks', async () => {
    const token = await m.createLoginLink(app.ctx, 'ops@harville.ai');
    clock += m.LINK_TTL_MS + 1;
    await expect(m.redeemLoginLink(app.ctx, token)).rejects.toThrow('expired');
    const { session } = await m.redeemLoginLink(
      app.ctx,
      await m.createLoginLink(app.ctx, 'ops@harville.ai'),
    );
    clock += m.SESSION_TTL_MS + 1;
    expect(await m.sessionUser(app.ctx, session)).toBeUndefined();
  });
});

describe('sites, seats, and roles', () => {
  test('only operators create sites; IDs are validated and unique', async () => {
    const { owner } = await acme();
    await expect(
      m.createSite(app.ctx, owner, { slug: 'x-co', name: 'X', seats: 1, ownerEmail: 'a@x.co' }),
    ).rejects.toThrow('operators');
    await expect(
      m.createSite(app.ctx, ops, { slug: 'Bad Slug', name: 'X', seats: 1, ownerEmail: 'a@x.co' }),
    ).rejects.toThrow('site ID');
    await expect(
      m.createSite(app.ctx, ops, { slug: 'acme', name: 'X', seats: 1, ownerEmail: 'a@x.co' }),
    ).rejects.toThrow('already exists');
    expect((await m.listSites(app.ctx))[0]).toMatchObject({ slug: 'acme', used: 1 });
  });

  test('invitations take seats and the limit holds', async () => {
    const { site, owner, ownerM } = await acme(2);
    await m.invite(app.ctx, site, owner, ownerM, 'dev@acme.com', 'member');
    await expect(m.invite(app.ctx, site, owner, ownerM, 'more@acme.com', 'member')).rejects.toThrow(
      'All 2 seats are taken',
    );
    await expect(m.invite(app.ctx, site, owner, ownerM, 'dev@acme.com', 'member')).rejects.toThrow(
      'already a member',
    );
    await expect(m.invite(app.ctx, site, owner, ownerM, 'not an email', 'member')).rejects.toThrow(
      "isn't an email",
    );
  });

  test('members can’t manage; admins can’t touch owners; a site keeps an owner', async () => {
    const { site, owner, ownerM } = await acme(5);
    const dev = await member(site, owner, 'dev@acme.com');
    const lead = await member(site, owner, 'lead@acme.com', 'admin');
    await expect(m.invite(app.ctx, site, dev.user, dev.m, 'x@acme.com', 'member')).rejects.toThrow(
      'Only owners and admins',
    );
    await expect(m.invite(app.ctx, site, lead.user, lead.m, 'x@acme.com', 'owner')).rejects.toThrow(
      'Only owners can add owners',
    );
    await expect(m.changeRole(app.ctx, site, lead.user, lead.m, dev.user, 'owner')).rejects.toThrow(
      'Only owners',
    );
    await expect(m.removeMember(app.ctx, site, lead.user, lead.m, owner)).rejects.toThrow(
      'Only owners',
    );
    await expect(m.changeRole(app.ctx, site, owner, ownerM, owner, 'admin')).rejects.toThrow(
      'at least one owner',
    );
    await m.changeRole(app.ctx, site, owner, ownerM, lead.user, 'owner');
    await m.changeRole(app.ctx, site, owner, ownerM, owner, 'admin');
    const rows = await m.listMembers(app.ctx, site);
    expect(rows.map((r) => [r.user.email, r.role])).toEqual([
      ['dev@acme.com', 'member'],
      ['lead@acme.com', 'owner'],
      ['owner@acme.com', 'admin'],
    ]);
    expect((await m.auditLog(app.ctx, site)).map((a) => a.action)).toContain('member.role');
  });
});

describe('policy', () => {
  test('validated versions; the client view adds the org and telemetry setting', async () => {
    const { site, owner, ownerM } = await acme();
    const bad = await m.savePolicy(app.ctx, site, owner, ownerM, {
      restrictions: { maxDailyUsd: -1 },
    });
    expect(bad).toMatchObject({ problems: [expect.stringContaining('restrictions.maxDailyUsd')] });
    expect(
      await m.savePolicy(app.ctx, site, owner, ownerM, { restrictions: { maxDailyUsd: 5 } }, 'cap'),
    ).toEqual({ version: 1 });
    expect(await m.clientPolicy(app.ctx, site)).toEqual({
      restrictions: { maxDailyUsd: 5 },
      enforced: { telemetry: { enabled: true } },
      version: '1.on',
      org: { id: 'acme', name: 'Acme Corp' },
    });
    await m.setTelemetry(app.ctx, site, owner, ownerM, 'user');
    const fresh = (await m.siteBySlug(app.ctx, 'acme')) as m.Site;
    expect((await m.clientPolicy(app.ctx, fresh)).enforced).toEqual({});
    expect((await m.policyHistory(app.ctx, site))[0]).toMatchObject({
      version: 1,
      note: 'cap',
      by: 'owner@acme.com',
    });
  });
});

describe('the Harness client protocol, end to end', () => {
  /** `harness login --site acme` as `email`, approved in the browser. */
  async function login(email: string) {
    const site = (await m.siteBySlug(app.ctx, 'acme')) as m.Site;
    const client = new OrgClient(`${BASE}/s/acme`, clientFetch);
    const code = await client.startDeviceLogin();
    expect(code.verification_uri_complete).toBe(`${BASE}/s/acme/device?code=${code.user_code}`);
    expect(await client.pollDeviceToken(code.device_code)).toBe('pending');
    const user = (await m.userByEmail(app.ctx, email)) as m.User;
    // People type codes however they like.
    await m.decideDevice(app.ctx, site, user, code.user_code.toLowerCase().replace('-', ' '), true);
    clock += 10_000;
    const token = await client.pollDeviceToken(code.device_code);
    if (typeof token === 'string') throw new Error(`still ${token}`);
    return { client, token, site, user };
  }

  test('sign-in, policy with ETag, usage that accumulates, telemetry per site', async () => {
    const { site, owner, ownerM } = await acme();
    await m.savePolicy(app.ctx, site, owner, ownerM, { restrictions: { maxDailyUsd: 5 } });
    await member(site, owner, 'dev@acme.com');
    const { client, token } = await login('dev@acme.com');
    expect(token.org).toEqual({ id: 'acme', name: 'Acme Corp' });
    expect(token.user.email).toBe('dev@acme.com');

    const res = await client.fetchPolicy(token.access_token);
    if (res.status !== 'updated') throw new Error('no policy');
    expect(res.policy.restrictions.maxDailyUsd).toBe(5);
    expect(await client.fetchPolicy(token.access_token, res.etag)).toEqual({ status: 'unchanged' });

    const entry = {
      date: '2026-09-28',
      tier: 'remote' as const,
      provider: 'anthropic',
      model: 'claude-opus-5',
      calls: 2,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      costUsd: 0.5,
    };
    expect(await client.reportUsage(token.access_token, [entry])).toBe(true);
    expect(await client.reportUsage(token.access_token, [entry])).toBe(true);
    const usage = await m.usageSummary(app.ctx, site);
    expect(usage.totals).toEqual({ local: 0, remote: 4, costUsd: 1 });
    expect(usage.byMember[0]).toMatchObject({ email: 'dev@acme.com', calls: 4 });

    const report = telemetryReport('install-1');
    const tel = await clientFetch(`${BASE}/s/acme/v1/telemetry`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.access_token}` },
      body: JSON.stringify({ reports: [report] }),
    });
    expect(tel.status).toBe(204);
    const anon = await clientFetch(`${BASE}/api/telemetry/v1`, {
      method: 'POST',
      body: JSON.stringify({ reports: [telemetryReport('install-2')] }),
    });
    expect(anon.status).toBe(204);
    const bad = await clientFetch(`${BASE}/api/telemetry/v1`, {
      method: 'POST',
      body: JSON.stringify({ reports: [{ installId: 'x' }] }),
    });
    expect(bad.status).toBe(400);
    const summary = await m.telemetrySummary(app.ctx);
    expect(summary.installs).toBe(2);
    expect(summary.savingsUsd).toBeCloseTo(4);
    expect(summary.bySite.map((s) => s.site).sort()).toEqual(['(no site)', 'acme']);
  });

  test('non-members can’t approve; fast polling slows down; codes expire', async () => {
    await acme();
    const site = (await m.siteBySlug(app.ctx, 'acme')) as m.Site;
    const stranger = await m.ensureUser(app.ctx, 'stranger@evil.com');
    const client = new OrgClient(`${BASE}/s/acme`, clientFetch);
    const code = await client.startDeviceLogin();
    await expect(m.decideDevice(app.ctx, site, stranger, code.user_code, true)).rejects.toThrow(
      "isn't a member",
    );
    expect(await client.pollDeviceToken(code.device_code)).toBe('pending');
    expect(await client.pollDeviceToken(code.device_code)).toBe('slow_down');
    clock += 11 * 60_000;
    await expect(client.pollDeviceToken(code.device_code)).rejects.toBeInstanceOf(OrgAuthError);
  });

  test('a denied code is refused; an approved one is exchanged only once', async () => {
    const { site, owner } = await acme();
    await member(site, owner, 'dev@acme.com');
    const client = new OrgClient(`${BASE}/s/acme`, clientFetch);
    const denied = await client.startDeviceLogin();
    const dev = (await m.userByEmail(app.ctx, 'dev@acme.com')) as m.User;
    await m.decideDevice(app.ctx, site, dev, denied.user_code, false);
    await expect(client.pollDeviceToken(denied.device_code)).rejects.toThrow('denied');
    const { token } = await login('dev@acme.com');
    expect(token.access_token).toMatch(/^hsa_/);
  });

  test('refresh rotates tokens; removing a member signs out their devices', async () => {
    const { site, owner, ownerM } = await acme();
    await member(site, owner, 'dev@acme.com');
    const { client, token, user } = await login('dev@acme.com');
    const next = await client.refresh(token.refresh_token as string);
    await expect(client.refresh(token.refresh_token as string)).rejects.toBeInstanceOf(
      OrgAuthError,
    );
    await expect(client.fetchPolicy(token.access_token)).rejects.toBeInstanceOf(OrgAuthError);
    expect((await client.fetchPolicy(next.access_token)).status).toBe('updated');
    await m.removeMember(app.ctx, site, owner, ownerM, user);
    await expect(client.fetchPolicy(next.access_token)).rejects.toBeInstanceOf(OrgAuthError);
    await expect(client.refresh(next.refresh_token as string)).rejects.toBeInstanceOf(OrgAuthError);
  });

  test('access tokens last an hour', async () => {
    const { site, owner } = await acme();
    await member(site, owner, 'dev@acme.com');
    const { client, token } = await login('dev@acme.com');
    clock += m.ACCESS_TTL_MS + 1;
    await expect(client.fetchPolicy(token.access_token)).rejects.toBeInstanceOf(OrgAuthError);
  });

  test('members sign out only their own devices', async () => {
    const { site, owner, ownerM } = await acme();
    const a = await member(site, owner, 'a@acme.com');
    await member(site, owner, 'b@acme.com');
    await login('a@acme.com');
    await login('b@acme.com');
    const all = await m.listDevices(app.ctx, site);
    const bDevice = all.find((d) => d.email === 'b@acme.com');
    await expect(m.revokeDevice(app.ctx, site, a.user, a.m, bDevice?.id as string)).rejects.toThrow(
      'only sign out your own',
    );
    expect((await m.listDevices(app.ctx, site, a.user)).map((d) => d.email)).toEqual([
      'a@acme.com',
    ]);
    await m.revokeDevice(app.ctx, site, owner, ownerM, bDevice?.id as string);
    expect(await m.listDevices(app.ctx, site)).toHaveLength(1);
  });

  test('unknown sites and forged tokens', async () => {
    await expect(new OrgClient(`${BASE}/s/nope`, clientFetch).startDeviceLogin()).rejects.toThrow(
      'HTTP 404',
    );
    await acme();
    await expect(
      new OrgClient(`${BASE}/s/acme`, clientFetch).fetchPolicy('hsa_forged'),
    ).rejects.toBeInstanceOf(OrgAuthError);
  });
});

function telemetryReport(installId: string) {
  return {
    schema: 1,
    installId,
    day: '2026-09-27',
    version: '0.6.0',
    os: 'darwin',
    arch: 'arm64',
    calls: { local: 9, remote: 1 },
    tokens: {
      local: { input: 1, output: 1 },
      remote: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
    costUsd: 0.1,
    savingsUsd: 2,
    allRemoteUsd: 2.1,
    byRule: { default: { local: 9, remote: 0, costUsd: 0 } },
    remoteModels: {},
    providerTypes: ['ollama'],
    features: {
      localModels: 1,
      remoteModels: 1,
      escalationPolicy: 'auto',
      classifier: false,
      compaction: true,
      privatePaths: false,
      secrets: 'redact',
      mcpServers: 0,
      runtimes: 0,
      budget: false,
      organization: true,
    },
    turns: { end_turn: 3 },
    errors: 0,
    crashes: [],
  };
}
