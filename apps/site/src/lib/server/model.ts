/**
 * The site's domain logic: people, sites, seats, policy, devices, usage, and
 * telemetry (ADR 0010). Routes stay thin and call these; every rule (roles,
 * seat limits, token lifetimes) lives here, where tests exercise it directly.
 */
import { OrgPolicy } from '@harness/engine/org/schema';
import { DailyReport } from '@harness/engine/telemetry/schema';
import { and, count, desc, eq, gt, gte, isNull, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './db.ts';
import * as t from './schema.ts';
import { hashSecret, newId, newSecret, newUserCode, normalizeUserCode } from './tokens.ts';

export interface Ctx {
  db: Db;
  now: () => Date;
}

/**
 * Roles within one site. Operators run it and are assigned by a Harness
 * manager; operators and admins manage its members, policy, and devices.
 */
export const ROLES = ['operator', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  email: string;
  name: string | null;
  /** Harville Labs staff: see every site, create them, and assign their operators. */
  harnessManager: boolean;
}

export interface Site {
  id: string;
  slug: string;
  name: string;
  seats: number;
  telemetry: 'on' | 'off' | 'user';
}

export interface Membership {
  role: Role;
  status: 'active' | 'invited';
}

/** A rule was broken; the message is shown to the person who tried. */
export class SiteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'SiteError';
  }
}

const later = (ctx: Ctx, ms: number) => new Date(ctx.now().getTime() + ms);

export const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter an email address.' }));

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const toUser = (r: typeof t.users.$inferSelect): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  harnessManager: r.harnessManager,
});

export async function userByEmail(ctx: Ctx, email: string): Promise<User | undefined> {
  const [r] = await ctx.db.select().from(t.users).where(eq(t.users.email, email.toLowerCase()));
  return r ? toUser(r) : undefined;
}

export async function userById(ctx: Ctx, id: string): Promise<User | undefined> {
  const [r] = await ctx.db.select().from(t.users).where(eq(t.users.id, id));
  return r ? toUser(r) : undefined;
}

export async function ensureUser(ctx: Ctx, email: string, harnessManager = false): Promise<User> {
  const existing = await userByEmail(ctx, email);
  if (existing) {
    if (harnessManager && !existing.harnessManager) {
      await ctx.db.update(t.users).set({ harnessManager: true }).where(eq(t.users.id, existing.id));
      return { ...existing, harnessManager: true };
    }
    return existing;
  }
  const user: User = { id: newId(), email: email.toLowerCase(), name: null, harnessManager };
  await ctx.db
    .insert(t.users)
    .values({ ...user, createdAt: ctx.now() })
    .onConflictDoNothing();
  return (await userByEmail(ctx, email)) ?? user;
}

// ---------------------------------------------------------------------------
// Web sign-in: emailed links, then a session cookie
// ---------------------------------------------------------------------------

export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 14 * 86_400_000;

/** A single-use sign-in link token. Only for known addresses; callers say the same thing either way. */
export async function createLoginLink(ctx: Ctx, email: string, next?: string): Promise<string> {
  const token = newSecret('hsl');
  await ctx.db.insert(t.loginLinks).values({
    tokenHash: hashSecret(token),
    email: email.toLowerCase(),
    next: next ?? null,
    expiresAt: later(ctx, LINK_TTL_MS),
  });
  return token;
}

/** Use a sign-in link: a session token, the person, and where to go next. */
export async function redeemLoginLink(
  ctx: Ctx,
  token: string,
): Promise<{ session: string; user: User; next: string | null }> {
  const hash = hashSecret(token);
  // Marking it used in the same statement that checks it makes a link single-use under races.
  const [link] = await ctx.db
    .update(t.loginLinks)
    .set({ usedAt: ctx.now() })
    .where(
      and(
        eq(t.loginLinks.tokenHash, hash),
        isNull(t.loginLinks.usedAt),
        gt(t.loginLinks.expiresAt, ctx.now()),
      ),
    )
    .returning();
  if (!link)
    throw new SiteError('This sign-in link has expired or was already used. Ask for a new one.');
  const user = await ensureUser(ctx, link.email);
  // Signing in accepts every pending invitation for this address.
  await ctx.db
    .update(t.memberships)
    .set({ status: 'active' })
    .where(and(eq(t.memberships.userId, user.id), eq(t.memberships.status, 'invited')));
  const session = newSecret('hss');
  await ctx.db.insert(t.webSessions).values({
    idHash: hashSecret(session),
    userId: user.id,
    expiresAt: later(ctx, SESSION_TTL_MS),
    createdAt: ctx.now(),
  });
  return { session, user, next: link.next };
}

export async function sessionUser(
  ctx: Ctx,
  session: string | undefined,
): Promise<User | undefined> {
  if (!session) return undefined;
  const [r] = await ctx.db
    .select({ user: t.users })
    .from(t.webSessions)
    .innerJoin(t.users, eq(t.users.id, t.webSessions.userId))
    .where(
      and(eq(t.webSessions.idHash, hashSecret(session)), gt(t.webSessions.expiresAt, ctx.now())),
    );
  return r ? toUser(r.user) : undefined;
}

export async function endSession(ctx: Ctx, session: string): Promise<void> {
  await ctx.db.delete(t.webSessions).where(eq(t.webSessions.idHash, hashSecret(session)));
}

// ---------------------------------------------------------------------------
// Sites, memberships, and seats
// ---------------------------------------------------------------------------

const toSite = (r: typeof t.sites.$inferSelect): Site => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  seats: r.seats,
  telemetry: r.telemetry,
});

export async function siteBySlug(ctx: Ctx, slug: string): Promise<Site | undefined> {
  const [r] = await ctx.db.select().from(t.sites).where(eq(t.sites.slug, slug));
  return r ? toSite(r) : undefined;
}

function assertHarnessManager(actor: User, what: string): void {
  if (!actor.harnessManager) throw new SiteError(`Only Harness managers can ${what}.`, 403);
}

/** Every site, for Harness managers: seats in use and who operates it. */
export async function listSites(
  ctx: Ctx,
): Promise<(Site & { used: number; operators: string[] })[]> {
  const rows = await ctx.db
    .select({
      site: t.sites,
      used: count(t.memberships.userId),
      operators: sql<
        string[] | null
      >`array_agg(${t.users.email} order by ${t.users.email}) filter (where ${t.memberships.role} = 'operator')`,
    })
    .from(t.sites)
    .leftJoin(t.memberships, eq(t.memberships.siteId, t.sites.id))
    .leftJoin(t.users, eq(t.users.id, t.memberships.userId))
    .groupBy(t.sites.id)
    .orderBy(t.sites.name);
  return rows.map((r) => ({
    ...toSite(r.site),
    used: Number(r.used),
    operators: r.operators ?? [],
  }));
}

/** Create a site with its first operator (invited until they sign in). */
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
  if (await siteBySlug(ctx, input.slug))
    throw new SiteError(`A site with the ID "${input.slug}" already exists.`, 409);
  const site: Site = {
    id: newId(),
    slug: input.slug,
    name: input.name.trim() || input.slug,
    seats: input.seats,
    telemetry: 'on',
  };
  const email = Email.safeParse(input.operatorEmail);
  if (!email.success) throw new SiteError('The operator needs a valid email address.');
  const operator = await ensureUser(ctx, email.data);
  await ctx.db.transaction(async (tx) => {
    await tx.insert(t.sites).values({ ...site, createdAt: ctx.now() });
    await tx.insert(t.memberships).values({
      siteId: site.id,
      userId: operator.id,
      role: 'operator',
      status: 'invited',
      invitedBy: actor.id,
      createdAt: ctx.now(),
    });
  });
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
  await ctx.db.update(t.sites).set({ seats }).where(eq(t.sites.id, site.id));
  await audit(ctx, site.id, actor, 'site.seats', `${site.seats} → ${seats}`);
}

export async function membership(
  ctx: Ctx,
  site: Site,
  user: User,
): Promise<Membership | undefined> {
  const [r] = await ctx.db
    .select({ role: t.memberships.role, status: t.memberships.status })
    .from(t.memberships)
    .where(and(eq(t.memberships.siteId, site.id), eq(t.memberships.userId, user.id)));
  return r;
}

/** Sites a person is an active member of, for the home page. */
export async function sitesOf(ctx: Ctx, user: User): Promise<(Site & { role: Role })[]> {
  const rows = await ctx.db
    .select({ site: t.sites, role: t.memberships.role })
    .from(t.memberships)
    .innerJoin(t.sites, eq(t.sites.id, t.memberships.siteId))
    .where(and(eq(t.memberships.userId, user.id), eq(t.memberships.status, 'active')))
    .orderBy(t.sites.name);
  return rows.map((r) => ({ ...toSite(r.site), role: r.role }));
}

export async function seatsUsed(ctx: Ctx, site: Site): Promise<number> {
  const [r] = await ctx.db
    .select({ n: count() })
    .from(t.memberships)
    .where(eq(t.memberships.siteId, site.id));
  return Number(r?.n ?? 0);
}

export interface MemberRow {
  user: User;
  role: Role;
  status: Membership['status'];
  devices: number;
  lastSeen: Date | null;
}

export async function listMembers(ctx: Ctx, site: Site): Promise<MemberRow[]> {
  const rows = await ctx.db
    .select({
      user: t.users,
      role: t.memberships.role,
      status: t.memberships.status,
      devices: sql<number>`count(${t.devices.id}) filter (where ${t.devices.revokedAt} is null)`,
      lastSeen: max(t.devices.lastSeenAt),
    })
    .from(t.memberships)
    .innerJoin(t.users, eq(t.users.id, t.memberships.userId))
    .leftJoin(
      t.devices,
      and(eq(t.devices.siteId, t.memberships.siteId), eq(t.devices.userId, t.users.id)),
    )
    .where(eq(t.memberships.siteId, site.id))
    .groupBy(t.users.id, t.memberships.role, t.memberships.status)
    .orderBy(t.users.email);
  return rows.map((r) => ({
    user: toUser(r.user),
    role: r.role,
    status: r.status,
    devices: Number(r.devices),
    lastSeen: r.lastSeen ? new Date(r.lastSeen) : null,
  }));
}

/** Operators and admins manage a site; Harness managers manage every site. */
export function canManage(m: Membership | undefined, user: User): boolean {
  return (
    user.harnessManager || (m?.status === 'active' && (m.role === 'operator' || m.role === 'admin'))
  );
}

function assertManager(m: Membership | undefined, user: User): void {
  if (!canManage(m, user)) throw new SiteError('Only operators and admins can do that.', 403);
}

/** Operators are Harville Labs' contact at a company, so only a Harness manager assigns them. */
function assertMayAssign(actor: User, from: Role | undefined, to: Role | undefined): void {
  if ((from === 'operator' || to === 'operator') && !actor.harnessManager)
    throw new SiteError('Only a Harness manager can assign or remove site operators.', 403);
}

/** Invite someone. Takes a seat right away, so a site can't be oversubscribed. */
export async function invite(
  ctx: Ctx,
  site: Site,
  actor: User,
  actorMembership: Membership | undefined,
  emailInput: string,
  role: Role,
): Promise<User> {
  assertManager(actorMembership, actor);
  const email = Email.safeParse(emailInput);
  if (!email.success) throw new SiteError(`"${emailInput}" isn't an email address.`);
  assertMayAssign(actor, undefined, role);
  const user = await ensureUser(ctx, email.data);
  if (await membership(ctx, site, user))
    throw new SiteError(`${user.email} is already a member of ${site.name}.`, 409);
  if ((await seatsUsed(ctx, site)) >= site.seats)
    throw new SiteError(
      `All ${site.seats} seats are taken. Remove a member, or contact Harville Labs for more seats.`,
      409,
    );
  await ctx.db.insert(t.memberships).values({
    siteId: site.id,
    userId: user.id,
    role,
    status: 'invited',
    invitedBy: actor.id,
    createdAt: ctx.now(),
  });
  await audit(ctx, site.id, actor, 'member.invited', `${user.email} as ${role}`);
  return user;
}

async function operatorCount(ctx: Ctx, site: Site): Promise<number> {
  const [r] = await ctx.db
    .select({ n: count() })
    .from(t.memberships)
    .where(and(eq(t.memberships.siteId, site.id), eq(t.memberships.role, 'operator')));
  return Number(r?.n ?? 0);
}

export async function changeRole(
  ctx: Ctx,
  site: Site,
  actor: User,
  actorMembership: Membership | undefined,
  target: User,
  role: Role,
): Promise<void> {
  assertManager(actorMembership, actor);
  const current = await membership(ctx, site, target);
  if (!current) throw new SiteError(`${target.email} isn't a member.`, 404);
  if (current.role === role) return;
  assertMayAssign(actor, current.role, role);
  if (current.role === 'operator' && (await operatorCount(ctx, site)) <= 1)
    throw new SiteError('A site needs at least one operator. Assign another operator first.');
  await ctx.db
    .update(t.memberships)
    .set({ role })
    .where(and(eq(t.memberships.siteId, site.id), eq(t.memberships.userId, target.id)));
  await audit(ctx, site.id, actor, 'member.role', `${target.email}: ${current.role} → ${role}`);
}

/** Remove a member: frees the seat and signs out every device they signed in. */
export async function removeMember(
  ctx: Ctx,
  site: Site,
  actor: User,
  actorMembership: Membership | undefined,
  target: User,
): Promise<void> {
  assertManager(actorMembership, actor);
  const current = await membership(ctx, site, target);
  if (!current) throw new SiteError(`${target.email} isn't a member.`, 404);
  assertMayAssign(actor, current.role, undefined);
  if (current.role === 'operator' && (await operatorCount(ctx, site)) <= 1)
    throw new SiteError('A site needs at least one operator. Assign another operator first.');
  await ctx.db.transaction(async (tx) => {
    await tx
      .delete(t.memberships)
      .where(and(eq(t.memberships.siteId, site.id), eq(t.memberships.userId, target.id)));
    await tx
      .update(t.devices)
      .set({ revokedAt: ctx.now() })
      .where(
        and(
          eq(t.devices.siteId, site.id),
          eq(t.devices.userId, target.id),
          isNull(t.devices.revokedAt),
        ),
      );
  });
  await audit(ctx, site.id, actor, 'member.removed', target.email);
}

/**
 * Harness manager: make someone an operator of a site. A member is promoted in
 * place; anyone else is invited, which takes a seat like any invitation.
 */
export async function assignOperator(
  ctx: Ctx,
  site: Site,
  actor: User,
  emailInput: string,
): Promise<User> {
  assertHarnessManager(actor, 'assign site operators');
  const email = Email.safeParse(emailInput);
  if (!email.success) throw new SiteError(`"${emailInput}" isn't an email address.`);
  const existing = await userByEmail(ctx, email.data);
  if (existing && (await membership(ctx, site, existing))) {
    await changeRole(ctx, site, actor, undefined, existing, 'operator');
    return existing;
  }
  return invite(ctx, site, actor, undefined, email.data, 'operator');
}

// ---------------------------------------------------------------------------
// Harness managers (Harville Labs staff)
// ---------------------------------------------------------------------------

export async function listHarnessManagers(ctx: Ctx): Promise<User[]> {
  const rows = await ctx.db
    .select()
    .from(t.users)
    .where(eq(t.users.harnessManager, true))
    .orderBy(t.users.email);
  return rows.map(toUser);
}

/**
 * Grant or revoke Harness manager access. Nobody can revoke their own, so
 * there's always someone left who can. Addresses in MANAGER_EMAILS are
 * granted again at every startup.
 */
export async function setHarnessManager(
  ctx: Ctx,
  actor: User,
  emailInput: string,
  grant: boolean,
): Promise<User> {
  assertHarnessManager(actor, 'change who is a Harness manager');
  const email = Email.safeParse(emailInput);
  if (!email.success) throw new SiteError(`"${emailInput}" isn't an email address.`);
  if (!grant && email.data === actor.email)
    throw new SiteError("You can't remove your own Harness manager access.");
  const user = grant ? await ensureUser(ctx, email.data) : await userByEmail(ctx, email.data);
  if (!user) throw new SiteError(`${email.data} isn't a Harness manager.`, 404);
  await ctx.db.update(t.users).set({ harnessManager: grant }).where(eq(t.users.id, user.id));
  await audit(ctx, null, actor, grant ? 'manager.added' : 'manager.removed', user.email);
  return { ...user, harnessManager: grant };
}

export async function setTelemetry(
  ctx: Ctx,
  site: Site,
  actor: User,
  actorMembership: Membership | undefined,
  value: Site['telemetry'],
): Promise<void> {
  assertManager(actorMembership, actor);
  await ctx.db.update(t.sites).set({ telemetry: value }).where(eq(t.sites.id, site.id));
  await audit(ctx, site.id, actor, 'site.telemetry', `${site.telemetry} → ${value}`);
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
      by: t.users.email,
    })
    .from(t.policies)
    .leftJoin(t.users, eq(t.users.id, t.policies.createdBy))
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
// Devices: RFC 8628 device sign-in, then per-device tokens
// ---------------------------------------------------------------------------

const DEVICE_CODE_TTL_MS = 10 * 60_000;
export const POLL_INTERVAL_S = 5;
export const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 86_400_000;

export async function startDeviceSignIn(ctx: Ctx, site: Site, client: string | undefined) {
  const deviceCode = newSecret('hsd');
  for (let attempt = 0; ; attempt++) {
    const userCode = newUserCode();
    const inserted = await ctx.db
      .insert(t.deviceCodes)
      .values({
        codeHash: hashSecret(deviceCode),
        userCode,
        siteId: site.id,
        status: 'pending',
        client: client ?? null,
        expiresAt: later(ctx, DEVICE_CODE_TTL_MS),
      })
      .onConflictDoNothing({ target: t.deviceCodes.userCode })
      .returning({ userCode: t.deviceCodes.userCode });
    // A user-code collision is astronomically unlikely; draw again rather than fail.
    if (inserted.length || attempt >= 5)
      return {
        deviceCode,
        userCode,
        expiresIn: DEVICE_CODE_TTL_MS / 1000,
        interval: POLL_INTERVAL_S,
      };
  }
}

export async function pendingDevice(ctx: Ctx, site: Site, userCodeInput: string) {
  const code = normalizeUserCode(userCodeInput);
  const [r] = await ctx.db
    .select()
    .from(t.deviceCodes)
    .where(and(eq(t.deviceCodes.userCode, code), eq(t.deviceCodes.siteId, site.id)));
  if (r?.status !== 'pending' || r.expiresAt < ctx.now()) return undefined;
  return { userCode: code, client: r.client };
}

/** The signed-in person approves (or denies) a code their Harness shows. */
export async function decideDevice(
  ctx: Ctx,
  site: Site,
  user: User,
  userCodeInput: string,
  approve: boolean,
): Promise<void> {
  const pending = await pendingDevice(ctx, site, userCodeInput);
  if (!pending)
    throw new SiteError('That code has expired or was already used. Run `harness login` again.');
  if (approve && (await membership(ctx, site, user))?.status !== 'active')
    throw new SiteError(
      `${user.email} isn't a member of ${site.name}. Ask one of its admins to invite you.`,
      403,
    );
  await ctx.db
    .update(t.deviceCodes)
    .set({ status: approve ? 'approved' : 'denied', userId: user.id })
    .where(eq(t.deviceCodes.userCode, pending.userCode));
  if (approve) await audit(ctx, site.id, user, 'device.approved', pending.client ?? 'harness');
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  org: { id: string; name: string };
  user: { email: string; name?: string };
}

export type PollResult =
  | { error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' }
  | { tokens: TokenResponse };

export async function pollDevice(ctx: Ctx, site: Site, deviceCode: string): Promise<PollResult> {
  const hash = hashSecret(deviceCode);
  const [r] = await ctx.db
    .select()
    .from(t.deviceCodes)
    .where(and(eq(t.deviceCodes.codeHash, hash), eq(t.deviceCodes.siteId, site.id)));
  if (!r || r.expiresAt < ctx.now()) return { error: 'expired_token' };
  if (r.status === 'denied') return { error: 'access_denied' };
  if (r.status === 'pending') {
    const last = r.lastPollAt?.getTime() ?? 0;
    await ctx.db
      .update(t.deviceCodes)
      .set({ lastPollAt: ctx.now() })
      .where(eq(t.deviceCodes.codeHash, hash));
    return ctx.now().getTime() - last < (POLL_INTERVAL_S - 1) * 1000
      ? { error: 'slow_down' }
      : { error: 'authorization_pending' };
  }
  // Exchange once: only the poll that flips approved → used gets tokens.
  const [claimed] = await ctx.db
    .update(t.deviceCodes)
    .set({ status: 'used' })
    .where(and(eq(t.deviceCodes.codeHash, hash), eq(t.deviceCodes.status, 'approved')))
    .returning();
  const user = claimed?.userId ? await userById(ctx, claimed.userId) : undefined;
  if (!user) return { error: 'expired_token' };
  return { tokens: await issueDevice(ctx, site, user, claimed?.client ?? null) };
}

async function issueDevice(
  ctx: Ctx,
  site: Site,
  user: User,
  client: string | null,
): Promise<TokenResponse> {
  const access = newSecret('hsa');
  const refresh = newSecret('hsr');
  await ctx.db.insert(t.devices).values({
    id: newId(),
    siteId: site.id,
    userId: user.id,
    client,
    accessHash: hashSecret(access),
    accessExpiresAt: later(ctx, ACCESS_TTL_MS),
    refreshHash: hashSecret(refresh),
    refreshExpiresAt: later(ctx, REFRESH_TTL_MS),
    createdAt: ctx.now(),
    lastSeenAt: ctx.now(),
  });
  return tokenResponse(site, user, access, refresh);
}

function tokenResponse(site: Site, user: User, access: string, refresh: string): TokenResponse {
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: ACCESS_TTL_MS / 1000,
    org: { id: site.slug, name: site.name },
    user: { email: user.email, ...(user.name ? { name: user.name } : {}) },
  };
}

/** Rotate a device's tokens. The old refresh token stops working. */
export async function refreshDevice(
  ctx: Ctx,
  site: Site,
  refreshToken: string,
): Promise<TokenResponse | undefined> {
  const access = newSecret('hsa');
  const refresh = newSecret('hsr');
  // Checked and rotated in one statement, so a refresh token works exactly once.
  const [d] = await ctx.db
    .update(t.devices)
    .set({
      accessHash: hashSecret(access),
      accessExpiresAt: later(ctx, ACCESS_TTL_MS),
      refreshHash: hashSecret(refresh),
      refreshExpiresAt: later(ctx, REFRESH_TTL_MS),
      lastSeenAt: ctx.now(),
    })
    .where(
      and(
        eq(t.devices.refreshHash, hashSecret(refreshToken)),
        eq(t.devices.siteId, site.id),
        isNull(t.devices.revokedAt),
        gt(t.devices.refreshExpiresAt, ctx.now()),
      ),
    )
    .returning();
  if (!d) return undefined;
  const user = await userById(ctx, d.userId);
  if (!user || (await membership(ctx, site, user))?.status !== 'active') return undefined;
  return tokenResponse(site, user, access, refresh);
}

/** The member behind a client's access token, if it's valid for this site. */
export async function authenticateDevice(
  ctx: Ctx,
  site: Site,
  accessToken: string | undefined,
): Promise<{ user: User; deviceId: string } | undefined> {
  if (!accessToken) return undefined;
  const [d] = await ctx.db
    .select()
    .from(t.devices)
    .where(
      and(
        eq(t.devices.accessHash, hashSecret(accessToken)),
        eq(t.devices.siteId, site.id),
        isNull(t.devices.revokedAt),
        gt(t.devices.accessExpiresAt, ctx.now()),
      ),
    );
  if (!d) return undefined;
  const user = await userById(ctx, d.userId);
  if (!user || (await membership(ctx, site, user))?.status !== 'active') return undefined;
  await ctx.db.update(t.devices).set({ lastSeenAt: ctx.now() }).where(eq(t.devices.id, d.id));
  return { user, deviceId: d.id };
}

export async function listDevices(ctx: Ctx, site: Site, onlyFor?: User) {
  const rows = await ctx.db
    .select({
      id: t.devices.id,
      email: t.users.email,
      client: t.devices.client,
      createdAt: t.devices.createdAt,
      lastSeen: t.devices.lastSeenAt,
    })
    .from(t.devices)
    .innerJoin(t.users, eq(t.users.id, t.devices.userId))
    .where(
      and(
        eq(t.devices.siteId, site.id),
        isNull(t.devices.revokedAt),
        onlyFor ? eq(t.devices.userId, onlyFor.id) : undefined,
      ),
    )
    .orderBy(desc(t.devices.lastSeenAt));
  return rows;
}

/** Members may sign out their own devices; operators and admins anyone's. */
export async function revokeDevice(
  ctx: Ctx,
  site: Site,
  actor: User,
  actorMembership: Membership | undefined,
  deviceId: string,
): Promise<void> {
  const [d] = await ctx.db
    .select({ userId: t.devices.userId, email: t.users.email })
    .from(t.devices)
    .innerJoin(t.users, eq(t.users.id, t.devices.userId))
    .where(and(eq(t.devices.id, deviceId), eq(t.devices.siteId, site.id)));
  if (!d) throw new SiteError('No such device.', 404);
  if (d.userId !== actor.id && !canManage(actorMembership, actor))
    throw new SiteError('You can only sign out your own devices.', 403);
  await ctx.db.update(t.devices).set({ revokedAt: ctx.now() }).where(eq(t.devices.id, deviceId));
  await audit(ctx, site.id, actor, 'device.revoked', d.email);
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
      email: t.users.email,
      tier: t.usageDaily.tier,
      model: t.usageDaily.model,
      calls: t.usageDaily.calls,
      costUsd: t.usageDaily.costUsd,
    })
    .from(t.usageDaily)
    .innerJoin(t.users, eq(t.users.id, t.usageDaily.userId))
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
    .select({ report: t.telemetryReports.report, slug: t.sites.slug })
    .from(t.telemetryReports)
    .leftJoin(t.sites, eq(t.sites.id, t.telemetryReports.siteId))
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
    id: newId(),
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
      actor: t.users.email,
      action: t.auditLog.action,
      detail: t.auditLog.detail,
    })
    .from(t.auditLog)
    .leftJoin(t.users, eq(t.users.id, t.auditLog.actorId))
    .where(isNull(t.auditLog.siteId))
    .orderBy(desc(t.auditLog.at))
    .limit(limit);
}

export async function auditLog(ctx: Ctx, site: Site, limit = 200) {
  return ctx.db
    .select({
      at: t.auditLog.at,
      actor: t.users.email,
      action: t.auditLog.action,
      detail: t.auditLog.detail,
    })
    .from(t.auditLog)
    .leftJoin(t.users, eq(t.users.id, t.auditLog.actorId))
    .where(eq(t.auditLog.siteId, site.id))
    .orderBy(desc(t.auditLog.at))
    .limit(limit);
}
