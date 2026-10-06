/** Site settings and single sign-on: telemetry choice, the site's OIDC provider, and session rules. */
import { and, eq, gt } from 'drizzle-orm';
import { STAFF_SSO, siteProviderId } from '../auth.ts';
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

const DNS_PREFIX = '_switchback-sso';

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
 * Returns why not, or undefined. Switchback managers are held to the first rule
 * only: they reach sites through /admin, not the site's identity provider.
 */
export function sessionProblem(site: Site, actor: Actor): string | undefined {
  const { siteId, via } = actor.session;
  if (via === 'device') return 'Device tokens only work with the Switchback client.';
  if (siteId && siteId !== site.id)
    return `You signed in with another site's single sign-on, which only works for that site. Sign out, then sign in again.`;
  if (
    site.ssoRequired &&
    !actor.user.switchbackManager &&
    via !== `sso:${siteProviderId(site.slug)}`
  )
    return `${site.name} requires its single sign-on. Sign out, then sign in again with your ${site.name} account.`;
  return undefined;
}

/** Whether this sign-in may use the Switchback manager console. */
export function managerSessionProblem(ctx: Ctx, actor: Actor): string | undefined {
  if (!actor.user.switchbackManager) return 'Only Switchback managers can see this.';
  if (actor.session.siteId || actor.session.via === 'device')
    return 'This sign-in only works for one site. Sign out, then sign in as Harville Labs staff.';
  if (ctx.managerSsoRequired && actor.session.via !== `sso:${STAFF_SSO}`)
    return 'Switchback managers sign in with Harville Labs single sign-on. Sign out, then choose “Harville Labs staff”.';
  return undefined;
}
