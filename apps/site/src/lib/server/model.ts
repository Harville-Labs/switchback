/**
 * The site's domain logic: people, sites, seats, roles, single sign-on,
 * devices, policy, usage, and telemetry (ADR 0010, 0012, 0013). Routes stay
 * thin and call these; every rule lives here, where tests exercise it.
 *
 * Credentials are Better Auth's (auth.ts). Changes a site member makes go
 * through `ctx.auth.api` with their own session, so the plugins check their
 * permissions too; this file adds the rules Better Auth doesn't know (only
 * Harness managers assign operators, a site keeps one, invitations take
 * seats, SSO sessions stay on their site). Harness managers act on sites they
 * don't belong to, which the plugins don't model, so their changes to
 * memberships are written directly.
 */
import { OrgPolicy } from '@harness/engine/org/schema';
import { DailyReport } from '@harness/engine/telemetry/schema';
import { APIError } from 'better-auth/api';
import { and, count, desc, eq, gt, gte, isNull, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Auth, CLIENT_ID, MANAGER, OPERATOR, STAFF_SSO, siteProviderId } from './auth.ts';
import type { Db } from './db.ts';
import * as t from './schema.ts';

export interface Ctx {
  db: Db;
  auth: Auth;
  now: () => Date;
  /** Harness managers must sign in through Harville Labs' identity provider. */
  managerSsoRequired?: boolean;
}

/** Roles within one site. `operator` is Better Auth's organization `owner` (auth.ts). */
export const ROLES = ['operator', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];
const toPluginRole = (r: Role) => (r === 'operator' ? OPERATOR : r);
const fromPluginRole = (r: string): Role =>
  r.split(',').includes(OPERATOR)
    ? 'operator'
    : r.split(',').includes('admin')
      ? 'admin'
      : 'member';

export interface User {
  id: string;
  email: string;
  name: string | null;
  /** Harville Labs staff: see every site, create them, and assign their operators. */
  harnessManager: boolean;
}

/** A signed-in person: who, how they signed in, and the headers that prove it. */
export interface Actor {
  user: User;
  session: { id: string; siteId: string | null; via: string | null };
  headers: Headers;
}

export interface Site {
  id: string;
  slug: string;
  name: string;
  seats: number;
  telemetry: 'on' | 'off' | 'user';
  ssoRequired: boolean;
}

export interface Membership {
  id: string;
  role: Role;
}

/** A rule was broken; the message is shown to the person who tried. */
export class SiteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 502 = 400,
  ) {
    super(message);
    this.name = 'SiteError';
  }
}

/** Run a Better Auth call, turning its refusals into a SiteError with its message. */
async function authCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof APIError) {
      const status = err.statusCode;
      throw new SiteError(
        err.body?.message ?? err.message ?? 'That was refused.',
        status === 403 || status === 404 || status === 409 || status === 502 ? status : 400,
      );
    }
    throw err;
  }
}

export const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter an email address.' }));

function email(input: string): string {
  const e = Email.safeParse(input);
  if (!e.success) throw new SiteError(`"${input}" isn't an email address.`);
  return e.data;
}

// ---------------------------------------------------------------------------
// People and sign-in
// ---------------------------------------------------------------------------

const toUser = (r: typeof t.user.$inferSelect): User => ({
  id: r.id,
  email: r.email,
  name: r.name === r.email ? null : r.name,
  harnessManager: r.role === MANAGER,
});

export async function userByEmail(ctx: Ctx, address: string): Promise<User | undefined> {
  const [r] = await ctx.db.select().from(t.user).where(eq(t.user.email, address.toLowerCase()));
  return r ? toUser(r) : undefined;
}

export async function userById(ctx: Ctx, id: string): Promise<User | undefined> {
  const [r] = await ctx.db.select().from(t.user).where(eq(t.user.id, id));
  return r ? toUser(r) : undefined;
}

/**
 * The account for an address, created if needed. Accounts exist before anyone
 * signs in (sites and invitations create them), because sign-in never creates
 * one. `manager` is for MANAGER_EMAILS at startup.
 */
export async function ensureUser(ctx: Ctx, address: string, manager = false): Promise<User> {
  const e = email(address);
  let user = await userByEmail(ctx, e);
  if (!user) {
    // A system call (no session): Better Auth's admin plugin creates the account.
    await authCall(() =>
      ctx.auth.api.createUser({ body: { email: e, name: e, role: manager ? MANAGER : 'user' } }),
    );
    user = (await userByEmail(ctx, e)) as User;
  }
  if (manager && !user.harnessManager) {
    await ctx.db.update(t.user).set({ role: MANAGER }).where(eq(t.user.id, user.id));
    user = { ...user, harnessManager: true };
  }
  return user;
}

/** The signed-in person behind a request's cookie or bearer token. */
export async function actorFor(ctx: Ctx, headers: Headers): Promise<Actor | undefined> {
  const r = await ctx.auth.api.getSession({ headers }).catch(() => null);
  if (!r) return undefined;
  const s = r.session as typeof r.session & { siteId?: string | null; via?: string | null };
  return {
    user: toUser(r.user as typeof t.user.$inferSelect),
    session: { id: s.id, siteId: s.siteId ?? null, via: s.via ?? null },
    headers,
  };
}

/**
 * Start signing in. An address whose domain has single sign-on goes to its
 * identity provider (unless `link` asks for an emailed link instead); anyone
 * else we know gets a link. Unknown addresses get the same answer as known
 * ones, so the form can't be used to find out who has an account.
 */
export async function startSignIn(
  ctx: Ctx,
  headers: Headers,
  input: { email: string; next: string; link?: boolean },
): Promise<{ redirect: string } | { sent: string }> {
  const address = email(input.email);
  if (!input.link && (await ssoProviderForEmail(ctx, address))) {
    const r = await authCall(() =>
      ctx.auth.api.signInSSO({
        body: {
          email: address,
          callbackURL: input.next,
          errorCallbackURL: `/login?error=sso&next=${encodeURIComponent(input.next)}`,
          loginHint: address,
        },
        headers,
      }),
    );
    return { redirect: r.url };
  }
  if (await userByEmail(ctx, address))
    await authCall(() =>
      ctx.auth.api.signInMagicLink({ body: { email: address, callbackURL: input.next }, headers }),
    );
  return { sent: address };
}

/** Harville Labs staff sign in through Harville Labs' identity provider. */
export async function startStaffSignIn(ctx: Ctx, headers: Headers, next: string) {
  const r = await authCall(() =>
    ctx.auth.api.signInSSO({
      body: {
        providerId: STAFF_SSO,
        callbackURL: next,
        errorCallbackURL: `/login?error=sso&next=${encodeURIComponent(next)}`,
      },
      headers,
    }),
  );
  return { redirect: r.url };
}

export async function signOut(ctx: Ctx, headers: Headers): Promise<void> {
  await ctx.auth.api.signOut({ headers }).catch(() => undefined);
}

/** A verified site provider, or the staff provider, that covers this address's domain. */
async function ssoProviderForEmail(ctx: Ctx, address: string): Promise<string | undefined> {
  const domain = address.split('@')[1] ?? '';
  const staff = (await ctx.auth.$context).options.plugins?.find((p) => p.id === 'sso') as
    | { options?: { defaultSSO?: { providerId: string; domain: string }[] } }
    | undefined;
  const configured = staff?.options?.defaultSSO?.find((p) =>
    p.domain.split(',').some((d) => d.trim().toLowerCase() === domain),
  );
  if (configured) return configured.providerId;
  const rows = await ctx.db
    .select({ providerId: t.ssoProvider.providerId, domain: t.ssoProvider.domain })
    .from(t.ssoProvider)
    .where(eq(t.ssoProvider.domainVerified, true));
  return rows.find((r) => r.domain.split(',').some((d) => d.trim().toLowerCase() === domain))
    ?.providerId;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

const toSite = (r: typeof t.organization.$inferSelect): Site => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  seats: r.seats,
  telemetry: r.telemetry as Site['telemetry'],
  ssoRequired: r.ssoRequired,
});

export async function siteBySlug(ctx: Ctx, slug: string): Promise<Site | undefined> {
  const [r] = await ctx.db.select().from(t.organization).where(eq(t.organization.slug, slug));
  return r ? toSite(r) : undefined;
}

async function siteById(ctx: Ctx, id: string): Promise<Site | undefined> {
  const [r] = await ctx.db.select().from(t.organization).where(eq(t.organization.id, id));
  return r ? toSite(r) : undefined;
}

function assertHarnessManager(actor: User, what: string): void {
  if (!actor.harnessManager) throw new SiteError(`Only Harness managers can ${what}.`, 403);
}

/** Members plus pending invitations: an invitation holds a seat until it's answered. */
export async function seatsUsed(ctx: Ctx, site: Site): Promise<number> {
  const [m] = await ctx.db
    .select({ n: count() })
    .from(t.member)
    .where(eq(t.member.organizationId, site.id));
  const [i] = await ctx.db
    .select({ n: count() })
    .from(t.invitation)
    .where(pendingInvitations(ctx, site.id));
  return Number(m?.n ?? 0) + Number(i?.n ?? 0);
}

const pendingInvitations = (ctx: Ctx, siteId: string) =>
  and(
    eq(t.invitation.organizationId, siteId),
    eq(t.invitation.status, 'pending'),
    gt(t.invitation.expiresAt, ctx.now()),
  );

/** Every site, for Harness managers: seats in use and who operates it. */
export async function listSites(
  ctx: Ctx,
): Promise<(Site & { used: number; operators: string[]; sso: boolean })[]> {
  const sites = (await ctx.db.select().from(t.organization).orderBy(t.organization.name)).map(
    toSite,
  );
  const ops = await ctx.db
    .select({ siteId: t.member.organizationId, email: t.user.email })
    .from(t.member)
    .innerJoin(t.user, eq(t.user.id, t.member.userId))
    .where(eq(t.member.role, OPERATOR))
    .orderBy(t.user.email);
  const sso = await ctx.db
    .select({ siteId: t.ssoProvider.organizationId })
    .from(t.ssoProvider)
    .where(eq(t.ssoProvider.domainVerified, true));
  return Promise.all(
    sites.map(async (s) => ({
      ...s,
      used: await seatsUsed(ctx, s),
      operators: ops.filter((o) => o.siteId === s.id).map((o) => o.email),
      sso: sso.some((p) => p.siteId === s.id),
    })),
  );
}

/** Create a site with its first operator, who can then sign in and invite the team. */
export async function createSite(
  ctx: Ctx,
  actor: User,
  input: { slug: string; name: string; seats: number; operatorEmail: string },
): Promise<Site> {
  assertHarnessManager(actor, 'create sites');
  if (!SLUG.test(input.slug))
    throw new SiteError(
      'The site ID must be 3 to 40 lowercase letters, digits, or dashes, starting with a letter.',
    );
  if (!Number.isInteger(input.seats) || input.seats < 1)
    throw new SiteError('A site needs at least one seat.');
  if (!Email.safeParse(input.operatorEmail).success)
    throw new SiteError('The operator needs a valid email address.');
  if (await siteBySlug(ctx, input.slug))
    throw new SiteError(`A site with the ID "${input.slug}" already exists.`, 409);
  const operator = await ensureUser(ctx, input.operatorEmail);
  // No session headers: a system call, which makes `userId` the site's first operator.
  const org = await authCall(() =>
    ctx.auth.api.createOrganization({
      body: {
        name: input.name.trim() || input.slug,
        slug: input.slug,
        userId: operator.id,
        seats: input.seats,
        telemetry: 'on',
        ssoRequired: false,
      },
    }),
  );
  const site = (await siteById(ctx, org?.id ?? '')) as Site;
  await audit(
    ctx,
    site.id,
    actor,
    'site.created',
    `${site.seats} seats, operator ${operator.email}`,
  );
  return site;
}

export async function setSeats(ctx: Ctx, actor: User, site: Site, seats: number): Promise<void> {
  assertHarnessManager(actor, 'change seats');
  if (!Number.isInteger(seats) || seats < 1) throw new SiteError('A site needs at least one seat.');
  await ctx.db.update(t.organization).set({ seats }).where(eq(t.organization.id, site.id));
  await audit(ctx, site.id, actor, 'site.seats', `${site.seats} → ${seats}`);
}

// ---------------------------------------------------------------------------
// Members, invitations, and operators
// ---------------------------------------------------------------------------

export async function membership(
  ctx: Ctx,
  site: Site,
  user: User,
): Promise<Membership | undefined> {
  const [r] = await ctx.db
    .select({ id: t.member.id, role: t.member.role })
    .from(t.member)
    .where(and(eq(t.member.organizationId, site.id), eq(t.member.userId, user.id)));
  return r ? { id: r.id, role: fromPluginRole(r.role) } : undefined;
}

/** Sites a person belongs to, for the home page. */
export async function sitesOf(ctx: Ctx, user: User): Promise<(Site & { role: Role })[]> {
  const rows = await ctx.db
    .select({ site: t.organization, role: t.member.role })
    .from(t.member)
    .innerJoin(t.organization, eq(t.organization.id, t.member.organizationId))
    .where(eq(t.member.userId, user.id))
    .orderBy(t.organization.name);
  return rows.map((r) => ({ ...toSite(r.site), role: fromPluginRole(r.role) }));
}

/** Invitations waiting for this person, for the home page. */
export async function invitationsFor(ctx: Ctx, user: User) {
  return ctx.db
    .select({ id: t.invitation.id, site: t.organization.name, role: t.invitation.role })
    .from(t.invitation)
    .innerJoin(t.organization, eq(t.organization.id, t.invitation.organizationId))
    .where(
      and(
        eq(t.invitation.email, user.email),
        eq(t.invitation.status, 'pending'),
        gt(t.invitation.expiresAt, ctx.now()),
      ),
    );
}

export interface MemberRow {
  /** The user ID for members, the invitation ID for invitations. */
  id: string;
  email: string;
  role: Role;
  status: 'active' | 'invited';
  devices: number;
  lastSeen: Date | null;
}

export async function listMembers(ctx: Ctx, site: Site): Promise<MemberRow[]> {
  const members = await ctx.db
    .select({
      id: t.user.id,
      email: t.user.email,
      role: t.member.role,
      devices: sql<number>`count(${t.session.id})`,
      lastSeen: max(t.session.updatedAt),
    })
    .from(t.member)
    .innerJoin(t.user, eq(t.user.id, t.member.userId))
    .leftJoin(
      t.session,
      and(
        eq(t.session.userId, t.user.id),
        eq(t.session.siteId, site.id),
        eq(t.session.via, 'device'),
        gt(t.session.expiresAt, ctx.now()),
      ),
    )
    .where(eq(t.member.organizationId, site.id))
    .groupBy(t.user.id, t.member.role);
  const invited = await ctx.db
    .select({ id: t.invitation.id, email: t.invitation.email, role: t.invitation.role })
    .from(t.invitation)
    .where(pendingInvitations(ctx, site.id));
  return [
    ...members.map((m) => ({
      id: m.id,
      email: m.email,
      role: fromPluginRole(m.role),
      status: 'active' as const,
      devices: Number(m.devices),
      lastSeen: m.lastSeen ? new Date(m.lastSeen) : null,
    })),
    ...invited.map((i) => ({
      id: i.id,
      email: i.email,
      role: fromPluginRole(i.role ?? 'member'),
      status: 'invited' as const,
      devices: 0,
      lastSeen: null,
    })),
  ].sort((a, b) => a.email.localeCompare(b.email));
}

/** Operators and admins manage a site; Harness managers manage every site. */
export function canManage(m: Membership | undefined, user: User): boolean {
  return user.harnessManager || m?.role === 'operator' || m?.role === 'admin';
}

function assertManager(m: Membership | undefined, user: User): void {
  if (!canManage(m, user)) throw new SiteError('Only operators and admins can do that.', 403);
}

/** Operators are Harville Labs' contact at a company, so only a Harness manager assigns them. */
function assertMayAssign(actor: User, from: Role | undefined, to: Role | undefined): void {
  if ((from === 'operator' || to === 'operator') && !actor.harnessManager)
    throw new SiteError('Only a Harness manager can assign or remove site operators.', 403);
}

async function operatorCount(ctx: Ctx, site: Site): Promise<number> {
  const [r] = await ctx.db
    .select({ n: count() })
    .from(t.member)
    .where(and(eq(t.member.organizationId, site.id), eq(t.member.role, OPERATOR)));
  return Number(r?.n ?? 0);
}

async function assertSeat(ctx: Ctx, site: Site): Promise<void> {
  if ((await seatsUsed(ctx, site)) >= site.seats)
    throw new SiteError(
      `All ${site.seats} seats are taken. Remove a member, or contact Harville Labs for more seats.`,
      409,
    );
}

/**
 * Invite someone as a member or admin. A member of the site sends a Better
 * Auth invitation, which holds a seat until it's accepted; a Harness manager
 * who isn't a member adds the person directly.
 */
export async function invite(
  ctx: Ctx,
  site: Site,
  actor: Actor,
  emailInput: string,
  role: Role,
): Promise<User> {
  const mine = await membership(ctx, site, actor.user);
  assertManager(mine, actor.user);
  assertMayAssign(actor.user, undefined, role);
  const user = await ensureUser(ctx, emailInput);
  if (await membership(ctx, site, user))
    throw new SiteError(`${user.email} is already a member of ${site.name}.`, 409);
  if (mine) {
    await authCall(() =>
      ctx.auth.api.createInvitation({
        body: { email: user.email, role: toPluginRole(role) as 'member', organizationId: site.id },
        headers: actor.headers,
      }),
    );
  } else {
    await assertSeat(ctx, site);
    await authCall(() =>
      ctx.auth.api.addMember({
        body: { userId: user.id, role: toPluginRole(role) as 'member', organizationId: site.id },
      }),
    );
  }
  await audit(ctx, site.id, actor.user, 'member.invited', `${user.email} as ${role}`);
  return user;
}

/** Accept an invitation (the invited person, signed in with that address). */
export async function acceptInvitation(ctx: Ctx, actor: Actor, invitationId: string) {
  const r = await authCall(() =>
    ctx.auth.api.acceptInvitation({ body: { invitationId }, headers: actor.headers }),
  );
  const site = (await siteById(ctx, r?.invitation.organizationId ?? '')) as Site;
  await audit(ctx, site.id, actor.user, 'member.joined', actor.user.email);
  return site;
}

export async function invitation(ctx: Ctx, id: string) {
  const [r] = await ctx.db
    .select({
      id: t.invitation.id,
      email: t.invitation.email,
      role: t.invitation.role,
      status: t.invitation.status,
      expiresAt: t.invitation.expiresAt,
      site: t.organization.name,
      slug: t.organization.slug,
    })
    .from(t.invitation)
    .innerJoin(t.organization, eq(t.organization.id, t.invitation.organizationId))
    .where(eq(t.invitation.id, id));
  return r ? { ...r, role: fromPluginRole(r.role ?? 'member') } : undefined;
}

export async function cancelInvitation(
  ctx: Ctx,
  site: Site,
  actor: Actor,
  invitationId: string,
): Promise<void> {
  const mine = await membership(ctx, site, actor.user);
  assertManager(mine, actor.user);
  const inv = await invitation(ctx, invitationId);
  if (!inv || inv.slug !== site.slug) throw new SiteError('No such invitation.', 404);
  if (mine)
    await authCall(() =>
      ctx.auth.api.cancelInvitation({ body: { invitationId }, headers: actor.headers }),
    );
  else
    await ctx.db
      .update(t.invitation)
      .set({ status: 'canceled' })
      .where(eq(t.invitation.id, invitationId));
  await audit(ctx, site.id, actor.user, 'member.uninvited', inv.email);
}

export async function changeRole(
  ctx: Ctx,
  site: Site,
  actor: Actor,
  target: User,
  role: Role,
): Promise<void> {
  const mine = await membership(ctx, site, actor.user);
  assertManager(mine, actor.user);
  const current = await membership(ctx, site, target);
  if (!current) throw new SiteError(`${target.email} isn't a member.`, 404);
  if (current.role === role) return;
  assertMayAssign(actor.user, current.role, role);
  if (current.role === 'operator' && (await operatorCount(ctx, site)) <= 1)
    throw new SiteError('A site needs at least one operator. Assign another operator first.');
  if (mine && !actor.user.harnessManager)
    await authCall(() =>
      ctx.auth.api.updateMemberRole({
        body: { memberId: current.id, role: toPluginRole(role), organizationId: site.id },
        headers: actor.headers,
      }),
    );
  else
    await ctx.db
      .update(t.member)
      .set({ role: toPluginRole(role) })
      .where(eq(t.member.id, current.id));
  await audit(
    ctx,
    site.id,
    actor.user,
    'member.role',
    `${target.email}: ${current.role} → ${role}`,
  );
}

/** Remove a member: frees the seat and signs out every device they signed in to the site. */
export async function removeMember(
  ctx: Ctx,
  site: Site,
  actor: Actor,
  target: User,
): Promise<void> {
  const mine = await membership(ctx, site, actor.user);
  assertManager(mine, actor.user);
  const current = await membership(ctx, site, target);
  if (!current) throw new SiteError(`${target.email} isn't a member.`, 404);
  assertMayAssign(actor.user, current.role, undefined);
  if (current.role === 'operator' && (await operatorCount(ctx, site)) <= 1)
    throw new SiteError('A site needs at least one operator. Assign another operator first.');
  if (mine && !actor.user.harnessManager)
    await authCall(() =>
      ctx.auth.api.removeMember({
        body: { memberIdOrEmail: current.id, organizationId: site.id },
        headers: actor.headers,
      }),
    );
  else await ctx.db.delete(t.member).where(eq(t.member.id, current.id));
  await ctx.db
    .delete(t.session)
    .where(and(eq(t.session.userId, target.id), eq(t.session.siteId, site.id)));
  await audit(ctx, site.id, actor.user, 'member.removed', target.email);
}

/**
 * Harness manager: make someone an operator of a site. A member is promoted in
 * place; anyone else is added, taking a seat.
 */
export async function assignOperator(
  ctx: Ctx,
  site: Site,
  actor: Actor,
  emailInput: string,
): Promise<User> {
  assertHarnessManager(actor.user, 'assign site operators');
  const user = await ensureUser(ctx, emailInput);
  const current = await membership(ctx, site, user);
  if (current) {
    await changeRole(ctx, site, actor, user, 'operator');
    return user;
  }
  await assertSeat(ctx, site);
  await authCall(() =>
    ctx.auth.api.addMember({
      body: { userId: user.id, role: OPERATOR, organizationId: site.id },
    }),
  );
  await audit(ctx, site.id, actor.user, 'member.invited', `${user.email} as operator`);
  return user;
}

// ---------------------------------------------------------------------------
// Harness managers (Harville Labs staff)
// ---------------------------------------------------------------------------

export async function listHarnessManagers(ctx: Ctx): Promise<User[]> {
  const rows = await ctx.db
    .select()
    .from(t.user)
    .where(eq(t.user.role, MANAGER))
    .orderBy(t.user.email);
  return rows.map(toUser);
}

/**
 * Grant or revoke Harness manager access, through Better Auth's admin plugin
 * as the acting manager. Nobody can revoke their own, so there's always
 * someone left who can. Addresses in MANAGER_EMAILS are granted again at
 * every startup.
 */
export async function setHarnessManager(
  ctx: Ctx,
  actor: Actor,
  emailInput: string,
  grant: boolean,
): Promise<User> {
  assertHarnessManager(actor.user, 'change who is a Harness manager');
  const address = email(emailInput);
  if (!grant && address === actor.user.email)
    throw new SiteError("You can't remove your own Harness manager access.");
  const user = grant ? await ensureUser(ctx, address) : await userByEmail(ctx, address);
  if (!user) throw new SiteError(`${address} isn't a Harness manager.`, 404);
  await authCall(() =>
    ctx.auth.api.setRole({
      body: { userId: user.id, role: grant ? MANAGER : 'user' },
      headers: actor.headers,
    }),
  );
  // Revoked access ends the sessions that carried it.
  if (!grant) await ctx.db.delete(t.session).where(eq(t.session.userId, user.id));
  await audit(ctx, null, actor.user, grant ? 'manager.added' : 'manager.removed', user.email);
  return { ...user, harnessManager: grant };
}

// ---------------------------------------------------------------------------
// Site settings and single sign-on
// ---------------------------------------------------------------------------

export async function setTelemetry(
  ctx: Ctx,
  site: Site,
  actor: User,
  actorMembership: Membership | undefined,
  value: Site['telemetry'],
): Promise<void> {
  assertManager(actorMembership, actor);
  await ctx.db
    .update(t.organization)
    .set({ telemetry: value })
    .where(eq(t.organization.id, site.id));
  await audit(ctx, site.id, actor, 'site.telemetry', `${site.telemetry} → ${value}`);
}

export interface SiteSso {
  providerId: string;
  issuer: string;
  domain: string;
  verified: boolean;
  /** The DNS TXT record that proves the domain, while it's unverified. */
  record?: { name: string; value: string };
}

const DNS_PREFIX = '_harness-sso';

export async function siteSso(ctx: Ctx, site: Site): Promise<SiteSso | undefined> {
  const [p] = await ctx.db
    .select()
    .from(t.ssoProvider)
    .where(eq(t.ssoProvider.organizationId, site.id));
  if (!p) return undefined;
  const sso: SiteSso = {
    providerId: p.providerId,
    issuer: p.issuer,
    domain: p.domain,
    verified: Boolean(p.domainVerified),
  };
  if (!sso.verified) {
    const [v] = await ctx.db
      .select({ value: t.verification.value })
      .from(t.verification)
      .where(
        and(
          eq(t.verification.identifier, `${DNS_PREFIX}-${p.providerId}`),
          gt(t.verification.expiresAt, ctx.now()),
        ),
      );
    if (v) sso.record = { name: `${DNS_PREFIX}-${p.providerId}.${p.domain}`, value: v.value };
  }
  return sso;
}

/** SSO is configured by the site's own operators and admins, as members. */
async function assertSsoAdmin(ctx: Ctx, site: Site, actor: Actor): Promise<void> {
  const m = await membership(ctx, site, actor.user);
  if (m?.role !== 'operator' && m?.role !== 'admin')
    throw new SiteError("Only the site's operators and admins can set up its single sign-on.", 403);
}

/**
 * Set the site's OIDC identity provider. Replacing it starts domain
 * verification over: until the DNS record checks out, nobody can sign in with it.
 */
export async function configureSso(
  ctx: Ctx,
  site: Site,
  actor: Actor,
  input: { issuer: string; clientId: string; clientSecret: string; domain: string },
): Promise<SiteSso> {
  await assertSsoAdmin(ctx, site, actor);
  const domain = input.domain.trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain))
    throw new SiteError('Enter your email domain, like example.com.');
  if (!/^https:\/\//.test(input.issuer) && !input.issuer.startsWith('http://localhost'))
    throw new SiteError('The issuer must be an https:// URL.');
  const providerId = siteProviderId(site.slug);
  if (await siteSso(ctx, site))
    await authCall(() =>
      ctx.auth.api.deleteSSOProvider({ body: { providerId }, headers: actor.headers }),
    );
  await authCall(() =>
    ctx.auth.api.registerSSOProvider({
      body: {
        providerId,
        issuer: input.issuer.trim().replace(/\/+$/, ''),
        domain,
        organizationId: site.id,
        oidcConfig: {
          clientId: input.clientId.trim(),
          clientSecret: input.clientSecret.trim(),
          pkce: true,
        },
      },
      headers: actor.headers,
    }),
  );
  await authCall(() =>
    ctx.auth.api.requestDomainVerification({ body: { providerId }, headers: actor.headers }),
  );
  await ctx.db
    .update(t.organization)
    .set({ ssoRequired: false })
    .where(eq(t.organization.id, site.id));
  await audit(ctx, site.id, actor.user, 'sso.configured', `${input.issuer} for @${domain}`);
  return (await siteSso(ctx, site)) as SiteSso;
}

export async function verifySsoDomain(ctx: Ctx, site: Site, actor: Actor): Promise<void> {
  await assertSsoAdmin(ctx, site, actor);
  const providerId = siteProviderId(site.slug);
  await authCall(() => ctx.auth.api.verifyDomain({ body: { providerId }, headers: actor.headers }));
  await audit(ctx, site.id, actor.user, 'sso.verified', (await siteSso(ctx, site))?.domain);
}

export async function removeSso(ctx: Ctx, site: Site, actor: Actor): Promise<void> {
  await assertSsoAdmin(ctx, site, actor);
  await authCall(() =>
    ctx.auth.api.deleteSSOProvider({
      body: { providerId: siteProviderId(site.slug) },
      headers: actor.headers,
    }),
  );
  await ctx.db
    .update(t.organization)
    .set({ ssoRequired: false })
    .where(eq(t.organization.id, site.id));
  await audit(ctx, site.id, actor.user, 'sso.removed');
}

/** Require members to sign in through the site's (verified) identity provider. */
export async function setSsoRequired(
  ctx: Ctx,
  site: Site,
  actor: Actor,
  required: boolean,
): Promise<void> {
  await assertSsoAdmin(ctx, site, actor);
  if (required && !(await siteSso(ctx, site))?.verified)
    throw new SiteError('Verify your domain before requiring single sign-on.');
  if (required && actor.session.via !== `sso:${siteProviderId(site.slug)}`)
    throw new SiteError(
      'Sign in with your single sign-on first, so requiring it can’t lock you out.',
    );
  await ctx.db
    .update(t.organization)
    .set({ ssoRequired: required })
    .where(eq(t.organization.id, site.id));
  await audit(ctx, site.id, actor.user, 'sso.required', required ? 'on' : 'off');
}

/**
 * Whether this sign-in may be used on this site: SSO and device sessions are
 * bound to their site, and a site that requires SSO accepts only its own.
 * Returns why not, or undefined. Harness managers are held to the first rule
 * only: they reach sites through /admin, not the site's identity provider.
 */
export function sessionProblem(site: Site, actor: Actor): string | undefined {
  const { siteId, via } = actor.session;
  if (via === 'device') return 'Device tokens only work with the Harness client.';
  if (siteId && siteId !== site.id)
    return `You signed in with another site's single sign-on, which only works for that site. Sign out, then sign in again.`;
  if (site.ssoRequired && !actor.user.harnessManager && via !== `sso:${siteProviderId(site.slug)}`)
    return `${site.name} requires its single sign-on. Sign out, then sign in again with your ${site.name} account.`;
  return undefined;
}

/** Whether this sign-in may use the Harness manager console. */
export function managerSessionProblem(ctx: Ctx, actor: Actor): string | undefined {
  if (!actor.user.harnessManager) return 'Only Harness managers can see this.';
  if (actor.session.siteId || actor.session.via === 'device')
    return 'This sign-in only works for one site. Sign out, then sign in as Harville Labs staff.';
  if (ctx.managerSsoRequired && actor.session.via !== `sso:${STAFF_SSO}`)
    return 'Harness managers sign in with Harville Labs single sign-on. Sign out, then choose “Harville Labs staff”.';
  return undefined;
}

// ---------------------------------------------------------------------------
// Devices: Better Auth's device authorization (RFC 8628), bound to one site
// ---------------------------------------------------------------------------

const siteScope = (site: Site) => `site:${site.slug}`;

/** Every failure a device endpoint reports, as RFC 8628 / RFC 6749 errors. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly status = 400,
    readonly description?: string,
  ) {
    super(error);
  }
}

async function oauthCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof APIError) {
      const b = err.body as { error?: string; error_description?: string } | undefined;
      throw new OAuthError(b?.error ?? 'invalid_request', err.statusCode, b?.error_description);
    }
    throw err;
  }
}

export async function startDeviceSignIn(
  ctx: Ctx,
  site: Site,
  publicUrl: string,
  clientId: string | undefined,
) {
  const r = await oauthCall(() =>
    ctx.auth.api.deviceCode({ body: { client_id: clientId ?? '', scope: siteScope(site) } }),
  );
  // People approve on the site's own page, which checks they're a member.
  const uri = `${publicUrl}/s/${site.slug}/device`;
  return {
    ...r,
    verification_uri: uri,
    verification_uri_complete: `${uri}?user_code=${encodeURIComponent(r.user_code)}`,
  };
}

/** Exchange an approved device code for a token that works only on this site. */
export async function finishDeviceSignIn(
  ctx: Ctx,
  site: Site,
  body: { grant_type?: string; device_code?: string; client_id?: string },
  headers: Headers,
) {
  const r = await oauthCall(() =>
    ctx.auth.api.deviceToken({
      body: {
        grant_type: body.grant_type as 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: body.device_code ?? '',
        client_id: body.client_id ?? CLIENT_ID,
      },
      headers,
    }),
  );
  const [s] = await ctx.db
    .select({ id: t.session.id, userId: t.session.userId })
    .from(t.session)
    .where(eq(t.session.token, r.access_token));
  if (!s) throw new OAuthError('server_error', 500);
  // A code approved for another site's page never becomes a token for this one.
  if (r.scope !== siteScope(site)) {
    await ctx.db.delete(t.session).where(eq(t.session.id, s.id));
    throw new OAuthError('invalid_grant', 400, 'That code was issued for a different site.');
  }
  await ctx.db.update(t.session).set({ siteId: site.id }).where(eq(t.session.id, s.id));
  const user = (await userById(ctx, s.userId)) as User;
  await audit(ctx, site.id, user, 'device.signed_in', headers.get('user-agent') ?? undefined);
  return {
    ...r,
    // ADR 0007 clients show which organization and account they signed in to.
    org: { id: site.slug, name: site.name },
    user: { email: user.email, ...(user.name ? { name: user.name } : {}) },
  };
}

/** A code someone is about to approve: claimed for them by Better Auth, checked for this site. */
export async function pendingDevice(ctx: Ctx, site: Site, actor: Actor, userCode: string) {
  const r = await ctx.auth.api
    .deviceVerify({ query: { user_code: userCode }, headers: actor.headers })
    .catch(() => undefined);
  if (r?.status !== 'pending' || r.scope !== siteScope(site)) return undefined;
  return { userCode: r.user_code };
}

export async function decideDevice(
  ctx: Ctx,
  site: Site,
  actor: Actor,
  userCode: string,
  approve: boolean,
): Promise<void> {
  if (approve) {
    if (!(await membership(ctx, site, actor.user)))
      throw new SiteError(`You aren't a member of ${site.name}.`, 403);
    const problem = sessionProblem(site, actor);
    if (problem) throw new SiteError(problem, 403);
  }
  if (!(await pendingDevice(ctx, site, actor, userCode)))
    throw new SiteError('That code has expired or was already used. Run `harness login` again.');
  await authCall(() =>
    approve
      ? ctx.auth.api.deviceApprove({ body: { userCode }, headers: actor.headers })
      : ctx.auth.api.deviceDeny({ body: { userCode }, headers: actor.headers }),
  );
}

/** The member behind a device's bearer token, if it's valid for this site. */
export async function authenticateDevice(
  ctx: Ctx,
  site: Site,
  headers: Headers,
): Promise<User | undefined> {
  if (!headers.get('authorization')) return undefined;
  const actor = await actorFor(ctx, headers);
  if (actor?.session.via !== 'device' || actor.session.siteId !== site.id) return undefined;
  return (await membership(ctx, site, actor.user)) ? actor.user : undefined;
}

export async function listDevices(ctx: Ctx, site: Site, onlyFor?: User) {
  return ctx.db
    .select({
      id: t.session.id,
      email: t.user.email,
      client: t.session.userAgent,
      createdAt: t.session.createdAt,
      lastSeenAt: t.session.updatedAt,
    })
    .from(t.session)
    .innerJoin(t.user, eq(t.user.id, t.session.userId))
    .where(
      and(
        eq(t.session.siteId, site.id),
        eq(t.session.via, 'device'),
        gt(t.session.expiresAt, ctx.now()),
        onlyFor ? eq(t.session.userId, onlyFor.id) : undefined,
      ),
    )
    .orderBy(desc(t.session.updatedAt));
}

/** Members may sign out their own devices; operators and admins anyone's. */
export async function revokeDevice(
  ctx: Ctx,
  site: Site,
  actor: User,
  actorMembership: Membership | undefined,
  sessionId: string,
): Promise<void> {
  const [s] = await ctx.db
    .select({ userId: t.session.userId, email: t.user.email })
    .from(t.session)
    .innerJoin(t.user, eq(t.user.id, t.session.userId))
    .where(
      and(eq(t.session.id, sessionId), eq(t.session.siteId, site.id), eq(t.session.via, 'device')),
    );
  if (!s) throw new SiteError('No such device.', 404);
  if (s.userId !== actor.id) assertManager(actorMembership, actor);
  await ctx.db.delete(t.session).where(eq(t.session.id, sessionId));
  await audit(ctx, site.id, actor, 'device.revoked', s.email);
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * What admins edit: the policy without the parts the site fills in (`org`,
 * `version`). Validated with the same schema clients use.
 */
export const EditablePolicy = OrgPolicy.omit({ version: true, org: true });

export async function currentPolicy(
  ctx: Ctx,
  site: Site,
): Promise<{ version: number; body: Record<string, unknown> }> {
  const [r] = await ctx.db
    .select()
    .from(t.policies)
    .where(eq(t.policies.siteId, site.id))
    .orderBy(desc(t.policies.version))
    .limit(1);
  return r ? { version: r.version, body: r.body } : { version: 0, body: {} };
}

export async function policyHistory(ctx: Ctx, site: Site) {
  const rows = await ctx.db
    .select({
      version: t.policies.version,
      note: t.policies.note,
      createdAt: t.policies.createdAt,
      by: t.user.email,
    })
    .from(t.policies)
    .leftJoin(t.user, eq(t.user.id, t.policies.createdBy))
    .where(eq(t.policies.siteId, site.id))
    .orderBy(desc(t.policies.version));
  return rows;
}

export async function policyVersion(ctx: Ctx, site: Site, version: number) {
  const [r] = await ctx.db
    .select({ body: t.policies.body })
    .from(t.policies)
    .where(and(eq(t.policies.siteId, site.id), eq(t.policies.version, version)));
  return r?.body;
}

/** Save a new policy version, or return why it's invalid. */
export async function savePolicy(
  ctx: Ctx,
  site: Site,
  actor: User,
  actorMembership: Membership | undefined,
  body: unknown,
  note?: string,
): Promise<{ version: number } | { problems: string[] }> {
  assertManager(actorMembership, actor);
  const parsed = EditablePolicy.safeParse(body);
  if (!parsed.success)
    return {
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(policy)'}: ${i.message}`),
    };
  const { version } = await currentPolicy(ctx, site);
  const next = version + 1;
  await ctx.db.insert(t.policies).values({
    siteId: site.id,
    version: next,
    body: body as Record<string, unknown>,
    note: note?.trim() || null,
    createdBy: actor.id,
    createdAt: ctx.now(),
  });
  await audit(ctx, site.id, actor, 'policy.saved', `version ${next}${note ? `: ${note}` : ''}`);
  return { version: next };
}

/** The policy clients receive: the admins' policy plus the site's own settings. */
export async function clientPolicy(ctx: Ctx, site: Site): Promise<Record<string, unknown>> {
  const { version, body } = await currentPolicy(ctx, site);
  const enforced = { ...((body.enforced as Record<string, unknown> | undefined) ?? {}) };
  if (site.telemetry !== 'user') {
    const tel = (enforced.telemetry as Record<string, unknown> | undefined) ?? {};
    enforced.telemetry = { ...tel, enabled: site.telemetry === 'on' };
  }
  // The version covers site settings too, so clients see a telemetry change as an update.
  return {
    ...body,
    enforced,
    version: `${version}.${site.telemetry}`,
    org: { id: site.slug, name: site.name },
  };
}

// ---------------------------------------------------------------------------
// Usage and telemetry
// ---------------------------------------------------------------------------

const UsageEntry = z.object({
  date: z.iso.date(),
  tier: z.enum(['local', 'remote']),
  provider: z.string().max(200),
  model: z.string().max(200),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative(),
});

/** Add a member's usage. Clients report increments, so rows accumulate. */
export async function addUsage(
  ctx: Ctx,
  site: Site,
  user: User,
  entries: unknown,
): Promise<number> {
  const parsed = z.array(UsageEntry).max(10_000).parse(entries);
  if (!parsed.length) return 0;
  const u = t.usageDaily;
  await ctx.db
    .insert(u)
    .values(parsed.map((e) => ({ siteId: site.id, userId: user.id, ...e })))
    .onConflictDoUpdate({
      target: [u.siteId, u.userId, u.date, u.tier, u.provider, u.model],
      set: {
        calls: sql`${u.calls} + excluded.calls`,
        inputTokens: sql`${u.inputTokens} + excluded.input_tokens`,
        outputTokens: sql`${u.outputTokens} + excluded.output_tokens`,
        cacheReadTokens: sql`${u.cacheReadTokens} + excluded.cache_read_tokens`,
        costUsd: sql`${u.costUsd} + excluded.cost_usd`,
      },
    });
  return parsed.length;
}

export interface UsageSummary {
  from: string;
  totals: { local: number; remote: number; costUsd: number };
  byMember: { email: string; calls: number; localCalls: number; costUsd: number }[];
  byModel: { tier: string; model: string; calls: number; costUsd: number }[];
}

export async function usageSummary(
  ctx: Ctx,
  site: Site,
  days = 30,
  onlyFor?: User,
): Promise<UsageSummary> {
  const from = new Date(ctx.now().getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await ctx.db
    .select({
      email: t.user.email,
      tier: t.usageDaily.tier,
      model: t.usageDaily.model,
      calls: t.usageDaily.calls,
      costUsd: t.usageDaily.costUsd,
    })
    .from(t.usageDaily)
    .innerJoin(t.user, eq(t.user.id, t.usageDaily.userId))
    .where(
      and(
        eq(t.usageDaily.siteId, site.id),
        gte(t.usageDaily.date, from),
        onlyFor ? eq(t.usageDaily.userId, onlyFor.id) : undefined,
      ),
    );
  const totals = { local: 0, remote: 0, costUsd: 0 };
  const members = new Map<string, UsageSummary['byMember'][number]>();
  const models = new Map<string, UsageSummary['byModel'][number]>();
  for (const r of rows) {
    const local = r.tier === 'local';
    totals[r.tier] += r.calls;
    totals.costUsd += r.costUsd;
    const m = members.get(r.email) ?? { email: r.email, calls: 0, localCalls: 0, costUsd: 0 };
    m.calls += r.calls;
    if (local) m.localCalls += r.calls;
    m.costUsd += r.costUsd;
    members.set(r.email, m);
    const key = `${r.tier}\u0000${r.model}`;
    const mo = models.get(key) ?? { tier: r.tier, model: r.model, calls: 0, costUsd: 0 };
    mo.calls += r.calls;
    mo.costUsd += r.costUsd;
    models.set(key, mo);
  }
  const byCost = <T extends { costUsd: number; calls: number }>(a: T, b: T) =>
    b.costUsd - a.costUsd || b.calls - a.calls;
  return {
    from,
    totals,
    byMember: [...members.values()].sort(byCost),
    byModel: [...models.values()].sort(byCost),
  };
}

/** Store telemetry reports (schema-checked); a resent day replaces the earlier copy. */
export async function storeTelemetry(
  ctx: Ctx,
  site: Site | undefined,
  body: unknown,
): Promise<number> {
  const { reports } = z.object({ reports: z.array(DailyReport).max(60) }).parse(body);
  if (!reports.length) return 0;
  const tr = t.telemetryReports;
  await ctx.db
    .insert(tr)
    .values(
      reports.map((r) => ({
        installId: r.installId,
        day: r.day,
        siteId: site?.id ?? null,
        report: r,
        receivedAt: ctx.now(),
      })),
    )
    .onConflictDoUpdate({
      target: [tr.installId, tr.day],
      set: {
        siteId: sql`excluded.site_id`,
        report: sql`excluded.report`,
        receivedAt: sql`excluded.received_at`,
      },
    });
  return reports.length;
}

export interface TelemetrySummary {
  installs: number;
  calls: { local: number; remote: number };
  costUsd: number;
  savingsUsd: number;
  bySite: { site: string; installs: number; calls: number; costUsd: number; savingsUsd: number }[];
  byRule: { rule: string; local: number; remote: number; costUsd: number }[];
  versions: { version: string; installs: number }[];
  crashes: { day: string; site: string; name: string; message: string; stack: string }[];
}

/** Harness manager view: telemetry across every site (and unaffiliated installs) for recent days. */
export async function telemetrySummary(ctx: Ctx, days = 30): Promise<TelemetrySummary> {
  const from = new Date(ctx.now().getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await ctx.db
    .select({ report: t.telemetryReports.report, slug: t.organization.slug })
    .from(t.telemetryReports)
    .leftJoin(t.organization, eq(t.organization.id, t.telemetryReports.siteId))
    .where(gte(t.telemetryReports.day, from))
    .orderBy(t.telemetryReports.day);
  const out: TelemetrySummary = {
    installs: 0,
    calls: { local: 0, remote: 0 },
    costUsd: 0,
    savingsUsd: 0,
    bySite: [],
    byRule: [],
    versions: [],
    crashes: [],
  };
  const installs = new Set<string>();
  const sites = new Map<string, TelemetrySummary['bySite'][number] & { ids: Set<string> }>();
  const rules = new Map<string, TelemetrySummary['byRule'][number]>();
  const versions = new Map<string, Set<string>>();
  for (const row of rows) {
    const r = row.report as DailyReport;
    const site = row.slug ?? '(no site)';
    installs.add(r.installId);
    out.calls.local += r.calls.local;
    out.calls.remote += r.calls.remote;
    out.costUsd += r.costUsd;
    out.savingsUsd += r.savingsUsd;
    const s = sites.get(site) ?? {
      site,
      installs: 0,
      calls: 0,
      costUsd: 0,
      savingsUsd: 0,
      ids: new Set<string>(),
    };
    s.ids.add(r.installId);
    s.calls += r.calls.local + r.calls.remote;
    s.costUsd += r.costUsd;
    s.savingsUsd += r.savingsUsd;
    sites.set(site, s);
    for (const [rule, v] of Object.entries(r.byRule)) {
      const x = rules.get(rule) ?? { rule, local: 0, remote: 0, costUsd: 0 };
      x.local += v.local;
      x.remote += v.remote;
      x.costUsd += v.costUsd;
      rules.set(rule, x);
    }
    const v = versions.get(r.version) ?? new Set<string>();
    v.add(r.installId);
    versions.set(r.version, v);
    for (const c of r.crashes) out.crashes.push({ day: r.day, site, ...c });
  }
  out.installs = installs.size;
  out.bySite = [...sites.values()]
    .map(({ ids, ...s }) => ({ ...s, installs: ids.size }))
    .sort((a, b) => b.calls - a.calls);
  out.byRule = [...rules.values()].sort((a, b) => b.local + b.remote - (a.local + a.remote));
  out.versions = [...versions].map(([version, ids]) => ({ version, installs: ids.size }));
  out.crashes = out.crashes.slice(-50).reverse();
  return out;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function audit(
  ctx: Ctx,
  siteId: string | null,
  actor: User | undefined,
  action: string,
  detail?: string,
): Promise<void> {
  await ctx.db.insert(t.auditLog).values({
    id: crypto.randomUUID(),
    siteId,
    actorId: actor?.id ?? null,
    action,
    detail: detail ?? null,
    at: ctx.now(),
  });
}

/** Changes made outside any one site, such as granting Harness manager access. */
export async function platformAuditLog(ctx: Ctx, limit = 50) {
  return ctx.db
    .select({
      at: t.auditLog.at,
      actor: t.user.email,
      action: t.auditLog.action,
      detail: t.auditLog.detail,
    })
    .from(t.auditLog)
    .leftJoin(t.user, eq(t.user.id, t.auditLog.actorId))
    .where(isNull(t.auditLog.siteId))
    .orderBy(desc(t.auditLog.at))
    .limit(limit);
}

export async function auditLog(ctx: Ctx, site: Site, limit = 200) {
  return ctx.db
    .select({
      at: t.auditLog.at,
      actor: t.user.email,
      action: t.auditLog.action,
      detail: t.auditLog.detail,
    })
    .from(t.auditLog)
    .leftJoin(t.user, eq(t.user.id, t.auditLog.actorId))
    .where(eq(t.auditLog.siteId, site.id))
    .orderBy(desc(t.auditLog.at))
    .limit(limit);
}
