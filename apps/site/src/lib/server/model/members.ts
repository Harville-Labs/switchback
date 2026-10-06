/** Members, invitations, and operators: who belongs to a site and with which role. */
import { and, count, eq, gt, max, sql } from 'drizzle-orm';
import { OPERATOR } from '../auth.ts';
import * as t from '../schema.ts';
import { audit } from './audit.ts';
import {
  type Actor,
  authCall,
  type Ctx,
  fromPluginRole,
  type Membership,
  type Role,
  type Site,
  SiteError,
  toPluginRole,
  type User,
} from './core.ts';
import { ensureUser } from './people.ts';
import {
  assertSwitchbackManager,
  pendingInvitations,
  seatsUsed,
  siteById,
  toSite,
} from './sites.ts';

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

/** Operators and admins manage a site; Switchback managers manage every site. */
export function canManage(m: Membership | undefined, user: User): boolean {
  return user.switchbackManager || m?.role === 'operator' || m?.role === 'admin';
}

export function assertManager(m: Membership | undefined, user: User): void {
  if (!canManage(m, user)) throw new SiteError('Only operators and admins can do that.', 403);
}

/** Operators are Harville Labs' contact at a company, so only a Switchback manager assigns them. */
function assertMayAssign(actor: User, from: Role | undefined, to: Role | undefined): void {
  if ((from === 'operator' || to === 'operator') && !actor.switchbackManager)
    throw new SiteError('Only a Switchback manager can assign or remove site operators.', 403);
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
 * Auth invitation, which holds a seat until it's accepted; a Switchback manager
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
  if (mine && !actor.user.switchbackManager)
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
  if (mine && !actor.user.switchbackManager)
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
 * Switchback manager: make someone an operator of a site. A member is promoted in
 * place; anyone else is added, taking a seat.
 */
export async function assignOperator(
  ctx: Ctx,
  site: Site,
  actor: Actor,
  emailInput: string,
): Promise<User> {
  assertSwitchbackManager(actor.user, 'assign site operators');
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
