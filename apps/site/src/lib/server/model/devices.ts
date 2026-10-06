/** Devices: Better Auth's device authorization (RFC 8628), with tokens bound to one site. */
import { APIError } from 'better-auth/api';
import { and, desc, eq, gt } from 'drizzle-orm';
import { CLIENT_ID } from '../auth.ts';
import * as t from '../schema.ts';
import { audit } from './audit.ts';
import {
  type Actor,
  authCall,
  type Ctx,
  type Membership,
  type Site,
  SiteError,
  type User,
} from './core.ts';
import { assertManager, membership } from './members.ts';
import { actorFor, userById } from './people.ts';
import { sessionProblem } from './sso.ts';

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
  const uri = `${publicUrl}/sites/${site.slug}/device`;
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
    throw new SiteError('That code has expired or was already used. Run `switchback login` again.');
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
