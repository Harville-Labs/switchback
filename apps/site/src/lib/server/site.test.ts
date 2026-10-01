import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe as bunDescribe,
  expect,
  test,
} from 'bun:test';
import { OrgAuthError, OrgClient } from '@harness/engine';
import { eq } from 'drizzle-orm';
import { OAuth2Server } from 'oauth2-mock-server';
import postgres from 'postgres';
import * as api from './api.ts';
import { createAuth, siteProviderId } from './auth.ts';
import type { SiteApp } from './context.ts';
import { type Database, openDatabase } from './db.ts';
import { MemoryMailer } from './email.ts';
import * as m from './model.ts';
import * as t from './schema.ts';

/**
 * These run against a real Postgres: `bun run db:up`, then `bun run test` in
 * apps/site (CI provides one). Without TEST_DATABASE_URL they're skipped.
 * The database is wiped before every test, so never point this at real data.
 * Single sign-on runs against a real OIDC provider (oauth2-mock-server).
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
let mailer: MemoryMailer;
let ops: m.Actor;
let idp: OAuth2Server;
/** Who the test identity provider vouches for, in its ID tokens and userinfo. */
let idpClaims: Record<string, unknown> = {};

beforeAll(async () => {
  if (!TEST_DB) return;
  idp = new OAuth2Server();
  await idp.issuer.keys.generate('RS256');
  await idp.start(0, 'localhost');
  idp.service.on('beforeTokenSigning', (token) => Object.assign(token.payload, idpClaims));
  idp.service.on('beforeUserinfo', (res) => {
    res.body = idpClaims;
  });
});
afterAll(() => idp?.stop());

beforeEach(async () => {
  if (!TEST_DB) return;
  await resetDatabase(TEST_DB);
  database = await openDatabase(TEST_DB);
  mailer = new MemoryMailer();
  const auth = createAuth({
    db: database.db,
    publicUrl: BASE,
    secret: 'test-secret-that-is-long-enough-000000',
    mailer,
    // The test identity provider runs on localhost, which Better Auth only fetches when trusted.
    trustedOrigins: [idp.issuer.url as string],
    staffSso: {
      issuer: idp.issuer.url as string,
      clientId: 'harville-labs',
      clientSecret: 'staff-secret',
      domain: 'harville.ai',
    },
    devicePollSeconds: 1,
  });
  app = {
    ctx: { db: database.db, auth, now: () => new Date() },
    mailer,
    publicUrl: BASE,
    staffSso: true,
  };
  await m.ensureUser(app.ctx, 'ops@harville.ai', true);
  ops = await signIn('ops@harville.ai');
});
afterEach(() => database?.close());

/** Sign in with an emailed link, as the person who received it. */
async function signIn(email: string): Promise<m.Actor> {
  const r = await m.startSignIn(app.ctx, new Headers(), { email, next: '/', link: true });
  expect(r).toEqual({ sent: email });
  const link = new URL(/https:\S+/.exec(mailer.sent.at(-1)?.text ?? '')?.[0] ?? '');
  const verified = (await app.ctx.auth.api.magicLinkVerify({
    query: { token: link.searchParams.get('token') ?? '' },
    headers: new Headers(),
  })) as { token: string };
  return (await m.actorFor(
    app.ctx,
    new Headers({ authorization: `Bearer ${verified.token}` }),
  )) as m.Actor;
}

async function acme(seats = 3) {
  const site = await m.createSite(app.ctx, ops.user, {
    slug: 'acme',
    name: 'Acme Corp',
    seats,
    operatorEmail: 'operator@acme.com',
  });
  return { site, operator: await signIn('operator@acme.com') };
}

/** Invite someone, and have them sign in and accept. */
async function member(site: m.Site, by: m.Actor, email: string, role: m.Role = 'member') {
  await m.invite(app.ctx, site, by, email, role);
  const actor = await signIn(email);
  const [inv] = await m.invitationsFor(app.ctx, actor.user);
  await m.acceptInvitation(app.ctx, actor, inv?.id as string);
  return actor;
}

const members = async (site: m.Site) =>
  (await m.listMembers(app.ctx, site)).map((r) => [r.email, r.role, r.status]);

describe('sign-in', () => {
  test('a link works once and signs in only people who have an account', async () => {
    await m.startSignIn(app.ctx, new Headers(), { email: 'nobody@else.com', next: '/' });
    expect(mailer.sent).toHaveLength(1); // only ops@'s from setup
    const { site } = await acme();
    await m.startSignIn(app.ctx, new Headers(), {
      email: 'operator@acme.com',
      next: '/sites/acme',
    });
    const link = new URL(/https:\S+/.exec(mailer.sent.at(-1)?.text ?? '')?.[0] ?? '');
    expect(link.pathname).toBe('/api/auth/magic-link/verify');
    const token = link.searchParams.get('token') ?? '';
    await app.ctx.auth.api.magicLinkVerify({ query: { token }, headers: new Headers() });
    await expect(
      app.ctx.auth.api.magicLinkVerify({ query: { token }, headers: new Headers() }),
    ).rejects.toThrow();
    const actor = await signIn('operator@acme.com');
    expect(actor.session).toMatchObject({ siteId: null, via: 'magic-link' });
    expect(m.sessionProblem(site, actor)).toBeUndefined();
    await m.signOut(app.ctx, actor.headers);
    expect(await m.actorFor(app.ctx, actor.headers)).toBeUndefined();
  });
});

describe('sites, seats, and roles', () => {
  test('only Harness managers create sites; IDs are validated and unique', async () => {
    const { operator } = await acme();
    const create = (by: m.User, slug: string, operatorEmail = 'a@x.co') =>
      m.createSite(app.ctx, by, { slug, name: 'X', seats: 1, operatorEmail });
    await expect(create(operator.user, 'x-co')).rejects.toThrow('Only Harness managers');
    await expect(create(ops.user, 'Bad Slug')).rejects.toThrow('site ID');
    await expect(create(ops.user, 'acme')).rejects.toThrow('already exists');
    await expect(create(ops.user, 'y-co', 'nope')).rejects.toThrow('valid email');
    expect((await m.listSites(app.ctx))[0]).toMatchObject({
      slug: 'acme',
      used: 1,
      operators: ['operator@acme.com'],
    });
  });

  test('invitations hold seats until accepted or canceled', async () => {
    const { site, operator } = await acme(3);
    await m.invite(app.ctx, site, operator, 'dev@acme.com', 'member');
    await m.invite(app.ctx, site, operator, 'qa@acme.com', 'member');
    await expect(m.invite(app.ctx, site, operator, 'more@acme.com', 'member')).rejects.toThrow(
      'All 3 seats are taken',
    );
    await expect(m.invite(app.ctx, site, operator, 'not an email', 'member')).rejects.toThrow(
      "isn't an email",
    );
    expect(mailer.sent.at(-1)).toMatchObject({ to: 'qa@acme.com' });
    expect(mailer.sent.at(-1)?.text).toContain(`${BASE}/invite/`);

    const qa = (await m.listMembers(app.ctx, site)).find((r) => r.email === 'qa@acme.com');
    await m.cancelInvitation(app.ctx, site, operator, qa?.id as string);
    await m.invite(app.ctx, site, operator, 'more@acme.com', 'member');

    // Accepting takes the invited address; anyone else is refused.
    const stranger = await signIn('more@acme.com');
    const devInvite = (await m.listMembers(app.ctx, site)).find((r) => r.email === 'dev@acme.com');
    await expect(m.acceptInvitation(app.ctx, stranger, devInvite?.id as string)).rejects.toThrow();
    const dev = await signIn('dev@acme.com');
    expect((await m.acceptInvitation(app.ctx, dev, devInvite?.id as string)).slug).toBe('acme');
    expect(await members(site)).toEqual([
      ['dev@acme.com', 'member', 'active'],
      ['more@acme.com', 'member', 'invited'],
      ['operator@acme.com', 'operator', 'active'],
    ]);
  });

  test('only Harness managers assign or remove operators; a site keeps one', async () => {
    const { site, operator } = await acme(5);
    const dev = await member(site, operator, 'dev@acme.com');
    const lead = await member(site, operator, 'lead@acme.com', 'admin');
    const devUser = dev.user;
    await expect(m.invite(app.ctx, site, dev, 'x@acme.com', 'member')).rejects.toThrow(
      'Only operators and admins',
    );
    // Not even an operator can make or unmake operators.
    for (const who of [lead, operator]) {
      await expect(m.invite(app.ctx, site, who, 'x@acme.com', 'operator')).rejects.toThrow(
        'Only a Harness manager',
      );
      await expect(m.changeRole(app.ctx, site, who, devUser, 'operator')).rejects.toThrow(
        'Only a Harness manager',
      );
    }
    await expect(m.removeMember(app.ctx, site, lead, operator.user)).rejects.toThrow(
      'Only a Harness manager',
    );
    await expect(m.changeRole(app.ctx, site, operator, operator.user, 'admin')).rejects.toThrow(
      'Only a Harness manager',
    );
    // Operators and admins run everything else, through Better Auth's own checks.
    await m.changeRole(app.ctx, site, operator, devUser, 'admin');
    await m.changeRole(app.ctx, site, lead, devUser, 'member');

    await expect(m.changeRole(app.ctx, site, ops, operator.user, 'admin')).rejects.toThrow(
      'at least one operator',
    );
    await expect(m.removeMember(app.ctx, site, ops, operator.user)).rejects.toThrow(
      'at least one operator',
    );
    // A manager promotes a member in place, or adds someone new into a seat.
    await m.assignOperator(app.ctx, site, ops, 'lead@acme.com');
    await m.assignOperator(app.ctx, site, ops, 'new@acme.com');
    await m.changeRole(app.ctx, site, ops, operator.user, 'admin');
    await expect(m.assignOperator(app.ctx, site, operator, 'dev@acme.com')).rejects.toThrow(
      'Only Harness managers',
    );
    expect(await members(site)).toEqual([
      ['dev@acme.com', 'member', 'active'],
      ['lead@acme.com', 'operator', 'active'],
      ['new@acme.com', 'operator', 'active'],
      ['operator@acme.com', 'admin', 'active'],
    ]);
    expect((await m.auditLog(app.ctx, site)).map((a) => a.action)).toContain('member.role');
  });

  test('Harness managers see every site without taking a seat', async () => {
    const { site } = await acme(1);
    expect(await m.membership(app.ctx, site, ops.user)).toBeUndefined();
    expect(m.canManage(undefined, ops.user)).toBe(true);
    expect(m.sessionProblem(site, ops)).toBeUndefined();
    expect(m.managerSessionProblem(app.ctx, ops)).toBeUndefined();
    expect(await m.seatsUsed(app.ctx, site)).toBe(1);
  });

  test('Harness managers add and remove each other, but not themselves', async () => {
    const { operator } = await acme();
    await expect(m.setHarnessManager(app.ctx, operator, 'operator@acme.com', true)).rejects.toThrow(
      'Only Harness managers',
    );
    expect(m.managerSessionProblem(app.ctx, operator)).toContain('Only Harness managers');
    await m.setHarnessManager(app.ctx, ops, 'second@harville.ai', true);
    expect((await m.listHarnessManagers(app.ctx)).map((u) => u.email)).toEqual([
      'ops@harville.ai',
      'second@harville.ai',
    ]);
    await expect(m.setHarnessManager(app.ctx, ops, 'ops@harville.ai', false)).rejects.toThrow(
      'your own',
    );
    const second = await signIn('second@harville.ai');
    await m.setHarnessManager(app.ctx, second, 'ops@harville.ai', false);
    expect((await m.listHarnessManagers(app.ctx)).map((u) => u.email)).toEqual([
      'second@harville.ai',
    ]);
    // Revoking manager access ends the sessions that carried it.
    expect(await m.actorFor(app.ctx, ops.headers)).toBeUndefined();
    expect((await m.platformAuditLog(app.ctx)).map((a) => a.action).sort()).toEqual([
      'manager.added',
      'manager.removed',
    ]);
  });
});

describe('policy', () => {
  test('validated versions; the client view adds the org and telemetry setting', async () => {
    const { site, operator } = await acme();
    const opM = await m.membership(app.ctx, site, operator.user);
    const bad = await m.savePolicy(app.ctx, site, operator.user, opM, {
      restrictions: { maxDailyUsd: -1 },
    });
    expect(bad).toMatchObject({ problems: [expect.stringContaining('restrictions.maxDailyUsd')] });
    expect(
      await m.savePolicy(
        app.ctx,
        site,
        operator.user,
        opM,
        { restrictions: { maxDailyUsd: 5 } },
        'cap',
      ),
    ).toEqual({ version: 1 });
    expect(await m.clientPolicy(app.ctx, site)).toEqual({
      restrictions: { maxDailyUsd: 5 },
      enforced: { telemetry: { enabled: true } },
      version: '1.on',
      org: { id: 'acme', name: 'Acme Corp' },
    });
    await m.setTelemetry(app.ctx, site, operator.user, opM, 'user');
    const fresh = (await m.siteBySlug(app.ctx, 'acme')) as m.Site;
    expect((await m.clientPolicy(app.ctx, fresh)).enforced).toEqual({});
    expect((await m.policyHistory(app.ctx, site))[0]).toMatchObject({
      version: 1,
      note: 'cap',
      by: 'operator@acme.com',
    });
  });
});

/** The client protocol routes, as `fetch` sees them. */
const clientFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init);
  const path = new URL(req.url).pathname;
  if (path === '/api/telemetry/v1') return api.anonymousTelemetry(app, req);
  const match = /^\/sites\/([^/]+)\/v1\/(.+)$/.exec(path);
  const routes: Record<string, ReturnType<typeof api.forSite>> = {
    'device/code': api.deviceCode,
    token: api.deviceToken,
    policy: api.policy,
    usage: api.usage,
    telemetry: api.siteTelemetry,
  };
  const handler = match && routes[match[2] as string];
  return handler
    ? handler(app, match?.[1] as string, req)
    : new Response('not found', { status: 404 });
}) as typeof fetch;

describe('the Harness client protocol, end to end', () => {
  /** `harness login --site <slug>`, approved in the browser by `who`. */
  async function login(who: m.Actor, slug = 'acme') {
    const site = (await m.siteBySlug(app.ctx, slug)) as m.Site;
    const client = new OrgClient(`${BASE}/sites/${slug}`, clientFetch);
    const code = await client.startDeviceLogin();
    expect(code.verificationUriComplete).toBe(
      `${BASE}/sites/${slug}/device?user_code=${code.userCode}`,
    );
    await m.decideDevice(app.ctx, site, who, code.userCode, true);
    const token = await client.waitForDeviceToken(code);
    return { client, token, site };
  }

  test('sign-in, policy with ETag, usage that accumulates, telemetry per site', async () => {
    const { site, operator } = await acme();
    const opM = await m.membership(app.ctx, site, operator.user);
    await m.savePolicy(app.ctx, site, operator.user, opM, { restrictions: { maxDailyUsd: 5 } });
    const dev = await member(site, operator, 'dev@acme.com');
    const { client, token } = await login(dev);
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

    const tel = await clientFetch(`${BASE}/sites/acme/v1/telemetry`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.access_token}` },
      body: JSON.stringify({ reports: [telemetryReport('install-1')] }),
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

  test('a device token works only for its site, and never in the console', async () => {
    const { site, operator } = await acme();
    const dev = await member(site, operator, 'dev@acme.com');
    await m.createSite(app.ctx, ops.user, {
      slug: 'globex',
      name: 'Globex',
      seats: 2,
      operatorEmail: 'operator@globex.com',
    });
    const globexOp = await signIn('operator@globex.com');
    const globex = (await m.siteBySlug(app.ctx, 'globex')) as m.Site;
    await m.invite(app.ctx, globex, globexOp, 'dev@acme.com', 'member');
    const [inv] = await m.invitationsFor(app.ctx, dev.user);
    await m.acceptInvitation(app.ctx, dev, inv?.id as string);

    const { token } = await login(dev);
    const policyAt = (slug: string) =>
      clientFetch(`${BASE}/sites/${slug}/v1/policy`, {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
    expect((await policyAt('acme')).status).toBe(200);
    expect((await policyAt('globex')).status).toBe(401);
    const device = (await m.actorFor(
      app.ctx,
      new Headers({ authorization: `Bearer ${token.access_token}` }),
    )) as m.Actor;
    expect(device.session).toMatchObject({ via: 'device', siteId: site.id });
    expect(m.sessionProblem(site, device)).toContain('only work with the Harness client');

    // A code shown on Acme's page can't be redeemed at Globex's token endpoint.
    const acmeClient = new OrgClient(`${BASE}/sites/acme`, clientFetch);
    const code = await acmeClient.startDeviceLogin();
    await m.decideDevice(app.ctx, site, dev, code.userCode, true);
    const globexClient = new OrgClient(`${BASE}/sites/globex`, clientFetch);
    await expect(globexClient.waitForDeviceToken(code)).rejects.toThrow('different site');
  });

  test('non-members can’t approve; denied codes are refused', async () => {
    const { site, operator } = await acme();
    const dev = await member(site, operator, 'dev@acme.com');
    await m.ensureUser(app.ctx, 'stranger@evil.com');
    const stranger = await signIn('stranger@evil.com');
    const client = new OrgClient(`${BASE}/sites/acme`, clientFetch);
    const code = await client.startDeviceLogin();
    await expect(m.decideDevice(app.ctx, site, stranger, code.userCode, true)).rejects.toThrow(
      "aren't a member",
    );
    await m.decideDevice(app.ctx, site, dev, code.userCode, false);
    await expect(client.waitForDeviceToken(code)).rejects.toThrow('denied');
  });

  test('removing a member signs out their devices; members sign out only their own', async () => {
    const { site, operator } = await acme();
    const a = await member(site, operator, 'a@acme.com');
    const b = await member(site, operator, 'b@acme.com');
    const { client, token } = await login(a);
    await login(b);
    const aM = await m.membership(app.ctx, site, a.user);
    const bDevice = (await m.listDevices(app.ctx, site)).find((d) => d.email === 'b@acme.com');
    await expect(m.revokeDevice(app.ctx, site, a.user, aM, bDevice?.id as string)).rejects.toThrow(
      'Only operators and admins',
    );
    expect((await m.listDevices(app.ctx, site, a.user)).map((d) => d.email)).toEqual([
      'a@acme.com',
    ]);
    const opM = await m.membership(app.ctx, site, operator.user);
    await m.revokeDevice(app.ctx, site, operator.user, opM, bDevice?.id as string);
    expect(await m.listDevices(app.ctx, site)).toHaveLength(1);

    await m.removeMember(app.ctx, site, operator, a.user);
    await expect(client.fetchPolicy(token.access_token)).rejects.toBeInstanceOf(OrgAuthError);
  });
});

describe('single sign-on', () => {
  /** What the test identity provider says about the next person who signs in. */
  function idpSays(email: string) {
    idpClaims = { sub: `sub-${email}`, email, email_verified: true, name: email };
  }

  /** The browser's trip: Better Auth → identity provider → Better Auth's callback. */
  async function ssoSignIn(body: Record<string, string>, email: string) {
    idpSays(email);
    const start = await app.ctx.auth.handler(
      new Request(`${BASE}/api/auth/sign-in/sso`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ callbackURL: '/done', errorCallbackURL: '/failed', ...body }),
      }),
    );
    const { url } = (await start.json()) as { url: string };
    const cookie = start.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const atIdp = await fetch(url, { redirect: 'manual' });
    const callback = atIdp.headers.get('location') as string;
    const done = await app.ctx.auth.handler(new Request(callback, { headers: { cookie } }));
    const session = done.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const actor = await m.actorFor(app.ctx, new Headers({ cookie: session }));
    return { location: done.headers.get('location') ?? '', actor };
  }

  /** Acme's operator sets up SSO for acme.com; `verify` stands in for the DNS check. */
  async function acmeSso(verify = true) {
    const { site, operator } = await acme(5);
    const sso = await m.configureSso(app.ctx, site, operator, {
      issuer: idp.issuer.url as string,
      clientId: 'acme-client',
      clientSecret: 'acme-secret',
      domain: 'acme.com',
    });
    if (verify)
      await database.db
        .update(t.ssoProvider)
        .set({ domainVerified: true })
        .where(eq(t.ssoProvider.providerId, siteProviderId('acme')));
    return { site, operator, sso };
  }

  test('a site’s provider signs its members in to that site only', async () => {
    const { site, operator, sso } = await acmeSso(false);
    expect(sso.verified).toBe(false);
    expect(sso.record?.name).toBe('_harness-sso-site-acme.acme.com');
    // Unverified: the DNS record isn't there, and sign-in stays on emailed links.
    await expect(m.verifySsoDomain(app.ctx, site, operator)).rejects.toThrow();
    expect(
      await m.startSignIn(app.ctx, new Headers(), { email: 'operator@acme.com', next: '/' }),
    ).toEqual({ sent: 'operator@acme.com' });
    await database.db
      .update(t.ssoProvider)
      .set({ domainVerified: true })
      .where(eq(t.ssoProvider.providerId, siteProviderId('acme')));
    const start = await m.startSignIn(app.ctx, new Headers(), {
      email: 'operator@acme.com',
      next: '/',
    });
    expect('redirect' in start && start.redirect.startsWith(idp.issuer.url as string)).toBe(true);

    await member(site, operator, 'dev@acme.com');
    const { location, actor } = await ssoSignIn({ email: 'dev@acme.com' }, 'dev@acme.com');
    expect(location).toBe('/done');
    expect(actor?.user.email).toBe('dev@acme.com');
    expect(actor?.session).toMatchObject({ via: 'sso:site-acme', siteId: site.id });
    expect(m.sessionProblem(site, actor as m.Actor)).toBeUndefined();

    // The same person on another site, or a manager through Acme's provider, gets nowhere else.
    await m.createSite(app.ctx, ops.user, {
      slug: 'globex',
      name: 'Globex',
      seats: 2,
      operatorEmail: 'operator@globex.com',
    });
    const globex = (await m.siteBySlug(app.ctx, 'globex')) as m.Site;
    expect(m.sessionProblem(globex, actor as m.Actor)).toContain("another site's single sign-on");
    await m.assignOperator(app.ctx, site, ops, 'boss@acme.com');
    await m.setHarnessManager(app.ctx, ops, 'boss@acme.com', true);
    const boss = await ssoSignIn({ email: 'boss@acme.com' }, 'boss@acme.com');
    expect(boss.actor?.user.harnessManager).toBe(true);
    expect(m.managerSessionProblem(app.ctx, boss.actor as m.Actor)).toContain(
      'only works for one site',
    );
  });

  test('it refuses people who aren’t members, and addresses outside the domain', async () => {
    await acmeSso();
    const outsider = await ssoSignIn({ email: 'eve@acme.com' }, 'eve@acme.com');
    expect(outsider.actor).toBeUndefined();
    expect(outsider.location).toStartWith('/failed');
    // The provider claims someone from another domain.
    const spoof = await ssoSignIn({ providerId: siteProviderId('acme') }, 'ops@harville.ai');
    expect(spoof.actor).toBeUndefined();
    expect(spoof.location).toStartWith('/failed');
  });

  test('a site can require it, once the operator has used it', async () => {
    const { site, operator } = await acmeSso();
    await expect(m.setSsoRequired(app.ctx, site, operator, true)).rejects.toThrow(
      'Sign in with your single sign-on first',
    );
    const viaSso = (await ssoSignIn({ email: 'operator@acme.com' }, 'operator@acme.com'))
      .actor as m.Actor;
    await m.setSsoRequired(app.ctx, site, viaSso, true);
    const fresh = (await m.siteBySlug(app.ctx, 'acme')) as m.Site;
    expect(m.sessionProblem(fresh, operator)).toContain('requires its single sign-on');
    expect(m.sessionProblem(fresh, viaSso)).toBeUndefined();
    expect(m.sessionProblem(fresh, ops)).toBeUndefined(); // managers reach it through /admin
    // Only the site's own operators and admins set it up.
    await expect(
      m.configureSso(app.ctx, fresh, ops, {
        issuer: idp.issuer.url as string,
        clientId: 'x',
        clientSecret: 'y',
        domain: 'acme.com',
      }),
    ).rejects.toThrow("site's operators and admins");
  });

  test('Harville Labs’ provider signs in Harness managers only', async () => {
    const staff = await ssoSignIn({ providerId: 'harville-labs' }, 'ops@harville.ai');
    expect(staff.actor?.session).toMatchObject({ via: 'sso:harville-labs', siteId: null });
    expect(
      m.managerSessionProblem({ ...app.ctx, managerSsoRequired: true }, staff.actor as m.Actor),
    ).toBeUndefined();
    expect(m.managerSessionProblem({ ...app.ctx, managerSsoRequired: true }, ops)).toContain(
      'Harville Labs single sign-on',
    );
    await m.ensureUser(app.ctx, 'intern@harville.ai');
    const intern = await ssoSignIn({ providerId: 'harville-labs' }, 'intern@harville.ai');
    expect(intern.actor).toBeUndefined();
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
