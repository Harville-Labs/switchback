/** Sites: creating them, seats, and the listings Switchback managers see. */
import { and, count, eq, gt } from 'drizzle-orm';
import { OPERATOR } from '../auth.ts';
import * as t from '../schema.ts';
import { audit } from './audit.ts';
import { authCall, type Ctx, Email, type Site, SiteError, SLUG, type User } from './core.ts';
import { ensureUser } from './people.ts';

export const toSite = (r: typeof t.organization.$inferSelect): Site => ({
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

export async function siteById(ctx: Ctx, id: string): Promise<Site | undefined> {
  const [r] = await ctx.db.select().from(t.organization).where(eq(t.organization.id, id));
  return r ? toSite(r) : undefined;
}

export function assertSwitchbackManager(actor: User, what: string): void {
  if (!actor.switchbackManager) throw new SiteError(`Only Switchback managers can ${what}.`, 403);
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

export const pendingInvitations = (ctx: Ctx, siteId: string) =>
  and(
    eq(t.invitation.organizationId, siteId),
    eq(t.invitation.status, 'pending'),
    gt(t.invitation.expiresAt, ctx.now()),
  );

/** Every site, for Switchback managers: seats in use and who operates it. */
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
  assertSwitchbackManager(actor, 'create sites');
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
  assertSwitchbackManager(actor, 'change seats');
  if (!Number.isInteger(seats) || seats < 1) throw new SiteError('A site needs at least one seat.');
  await ctx.db.update(t.organization).set({ seats }).where(eq(t.organization.id, site.id));
  await audit(ctx, site.id, actor, 'site.seats', `${site.seats} → ${seats}`);
}
