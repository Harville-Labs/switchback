/**
 * Authentication, delegated to Better Auth (ADR 0013). The site writes no
 * credential handling of its own: sign-in links, sessions, the device flow
 * (RFC 8628), bearer tokens, OIDC single sign-on, organizations (sites),
 * invitations, and staff roles are Better Auth plugins.
 *
 * Browsers reach only the endpoints in PUBLIC_AUTH_PATHS (hooks.server.ts).
 * Everything else runs through the console's server actions, which apply the
 * site's rules (model.ts) and then call `auth.api` as the signed-in person, so
 * the plugins' own permission checks apply as well.
 */
import { type SSOOptions, sso } from '@better-auth/sso';
import { type BetterAuthPlugin, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { admin, bearer, deviceAuthorization, magicLink, organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements as adminStatements } from 'better-auth/plugins/admin/access';
import { and, count, eq, gt } from 'drizzle-orm';
import type { Db } from './db.ts';
import type { Mailer } from './email.ts';
import * as t from './schema.ts';

/**
 * A site operator is the site's organization `owner`: the plugins' checks for
 * owners (SSO provider management among them) apply to operators unchanged.
 * Only Switchback managers assign it (model.ts).
 */
export const OPERATOR = 'owner';
/** Harville Labs staff: the admin plugin's role, with only the permissions below. */
export const MANAGER = 'manager';
/** The device flow's only client. */
export const CLIENT_ID = 'switchback';
/** Harville Labs' own identity provider, for Switchback managers. */
export const STAFF_SSO = 'harville-labs';
/** Every site's identity provider is registered under this ID. */
export const siteProviderId = (slug: string) => `site-${slug}`;

/** The only Better Auth endpoints a browser may call; see hooks.server.ts. */
export const PUBLIC_AUTH_PATHS = [/^\/magic-link\/verify$/, /^\/sso\/callback\/[\w-]+$/];

const staff = createAccessControl(adminStatements);
/** Managers can see people and grant or revoke manager access; nothing else (no impersonation). */
const managerRole = staff.newRole({ user: ['list', 'get', 'set-role'], session: ['list'] });

export interface AuthConfig {
  db: Db;
  publicUrl: string;
  secret: string;
  mailer: Mailer;
  /** Harville Labs' OIDC provider for managers, if configured. */
  staffSso?: { issuer: string; clientId: string; clientSecret: string; domain: string };
  /** Extra origins to trust, for tests' local identity provider. */
  trustedOrigins?: string[];
  /** The SvelteKit cookie bridge, in the running app. */
  plugins?: BetterAuthPlugin[];
  /** Seconds between a device's polls (RFC 8628 says 5; tests use 1). */
  devicePollSeconds?: number;
}

export function createAuth(config: AuthConfig) {
  const { db, mailer } = config;

  /** Seats: members plus pending invitations, so a site can't be oversubscribed. */
  async function seatsTaken(siteId: string): Promise<number> {
    const [m] = await db
      .select({ n: count() })
      .from(t.member)
      .where(eq(t.member.organizationId, siteId));
    const [i] = await db
      .select({ n: count() })
      .from(t.invitation)
      .where(
        and(
          eq(t.invitation.organizationId, siteId),
          eq(t.invitation.status, 'pending'),
          gt(t.invitation.expiresAt, new Date()),
        ),
      );
    return Number(m?.n ?? 0) + Number(i?.n ?? 0);
  }

  /**
   * Who a verified SSO identity may sign in as. A site's provider signs in
   * only people with that site's email domain who are its members or have an
   * invitation to it, and the session it creates works only on that site.
   * Harville Labs' provider signs in only existing Switchback managers.
   */
  const resolveUser: SSOOptions['resolveUser'] = async (input) => {
    const email = input.providerUser.email.toLowerCase();
    const [user] = await db.select().from(t.user).where(eq(t.user.email, email));
    if (input.providerId === STAFF_SSO) {
      if (user?.role !== MANAGER)
        return {
          action: 'reject',
          code: 'not_a_manager',
          message: `${email} isn't a Switchback manager.`,
        };
      return { action: 'link', userId: user.id, profile: 'preserve' };
    }
    const [provider] = await db
      .select()
      .from(t.ssoProvider)
      .where(eq(t.ssoProvider.providerId, input.providerId));
    const siteId = provider?.organizationId;
    if (!provider || !siteId) return { action: 'reject', code: 'unknown_provider' };
    if (!provider.domain.split(',').some((d) => email.endsWith(`@${d.trim().toLowerCase()}`)))
      return {
        action: 'reject',
        code: 'wrong_domain',
        message: `This sign-in only accepts ${provider.domain} addresses.`,
      };
    const membership =
      user &&
      (await db
        .select({ id: t.member.id })
        .from(t.member)
        .where(and(eq(t.member.organizationId, siteId), eq(t.member.userId, user.id))));
    const invited = await db
      .select({ id: t.invitation.id })
      .from(t.invitation)
      .where(
        and(
          eq(t.invitation.organizationId, siteId),
          eq(t.invitation.email, email),
          eq(t.invitation.status, 'pending'),
        ),
      );
    if (!membership?.length && !invited.length)
      return {
        action: 'reject',
        code: 'not_a_member',
        message: `${email} isn't a member of this site. Ask its operator to invite you.`,
      };
    return user ? { action: 'link', userId: user.id, profile: 'preserve' } : { action: 'continue' };
  };

  const plugins = [
    magicLink({
      expiresIn: 15 * 60,
      // Only people Harville Labs or a site has added can sign in.
      disableSignUp: true,
      storeToken: 'hashed',
      sendMagicLink: async ({ email, url }) =>
        mailer.send({
          to: email,
          subject: 'Sign in to Switchback',
          text: `Sign in to Switchback:\n\n${url}\n\nThe link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`,
        }),
    }),
    deviceAuthorization({
      expiresIn: '10m',
      interval: `${config.devicePollSeconds ?? 5}s`,
      validateClient: (clientId) => clientId === CLIENT_ID,
    }),
    bearer(),
    admin({
      ac: staff,
      roles: { [MANAGER]: managerRole, user: staff.newRole({}) },
      adminRoles: [MANAGER],
      defaultRole: 'user',
    }),
    organization({
      allowUserToCreateOrganization: false,
      creatorRole: OPERATOR,
      disableOrganizationDeletion: true,
      requireEmailVerificationOnInvitation: true,
      cancelPendingInvitationsOnReInvite: true,
      invitationExpiresIn: 14 * 86_400,
      membershipLimit: (_user, site) => (site as { seats?: number }).seats ?? 0,
      schema: {
        organization: {
          additionalFields: {
            seats: { type: 'number', required: true, input: true },
            /** Members' telemetry: `on` / `off` (enforced), or `user` (their choice). */
            telemetry: { type: 'string', required: true, defaultValue: 'on', input: true },
            /** Members must sign in through the site's identity provider. */
            ssoRequired: { type: 'boolean', required: true, defaultValue: false, input: true },
          },
        },
      },
      organizationHooks: {
        beforeCreateInvitation: async ({ organization: site }) => {
          const seats = (site as { seats?: number }).seats ?? 0;
          if ((await seatsTaken(site.id)) >= seats)
            throw new APIError('FORBIDDEN', {
              message: `All ${seats} seats are taken. Remove a member, or contact Harville Labs for more seats.`,
            });
        },
      },
      sendInvitationEmail: async ({ email, organization: site, inviter, invitation, role }) =>
        mailer.send({
          to: email,
          subject: `You're invited to ${site.name} on Switchback`,
          text: `${inviter.user.email} invited you to ${site.name} on Switchback as ${role === 'member' ? 'a member' : `an ${role === OPERATOR ? 'operator' : role}`}.\n\nAccept at ${config.publicUrl}/invite/${invitation.id}\n\nThen connect Switchback with:\n\n  switchback login --site ${site.slug}\n`,
        }),
    }),
    sso({
      resolveUser,
      domainVerification: { enabled: true, tokenPrefix: 'switchback-sso' },
      // Sites get SSO from an operator, never by joining through it.
      organizationProvisioning: { disabled: true },
      disableImplicitSignUp: false,
      ...(config.staffSso
        ? {
            defaultSSO: [
              {
                providerId: STAFF_SSO,
                domain: config.staffSso.domain,
                oidcConfig: {
                  issuer: config.staffSso.issuer,
                  discoveryEndpoint: `${config.staffSso.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
                  clientId: config.staffSso.clientId,
                  clientSecret: config.staffSso.clientSecret,
                  pkce: true,
                },
              },
            ],
          }
        : {}),
    }),
    ...(config.plugins ?? []),
  ];

  return betterAuth({
    appName: 'Switchback',
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [config.publicUrl, ...(config.trustedOrigins ?? [])],
    // Transactions: SSO resolves users inside the same transaction that signs them in.
    database: drizzleAdapter(db, { provider: 'pg', schema: t, transaction: true }),
    emailAndPassword: { enabled: false },
    session: {
      // Rolling: a device or browser in use stays signed in.
      expiresIn: 30 * 86_400,
      updateAge: 86_400,
      additionalFields: {
        /** Set for device tokens and site SSO: this session works only on this site. */
        siteId: { type: 'string', required: false, input: false },
        /** How it was signed in: `magic-link`, `device`, or `sso:<provider>`. */
        via: { type: 'string', required: false, input: false },
      },
    },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      cookiePrefix: 'switchback',
      // Rate limits key on the client's address, which Traefik sets (it replaces
      // any the client sent, since no proxy in front of it is trusted).
      ipAddress: { ipAddressHeaders: ['x-real-ip', 'x-forwarded-for'] },
    },
    telemetry: { enabled: false },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            const path = ctx?.path ?? '';
            let via = 'magic-link';
            let siteId: string | null = null;
            if (path.startsWith('/sso/callback')) {
              const providerId = String(ctx?.params?.providerId ?? '');
              via = `sso:${providerId}`;
              if (providerId !== STAFF_SSO) {
                const [p] = await db
                  .select({ siteId: t.ssoProvider.organizationId })
                  .from(t.ssoProvider)
                  .where(eq(t.ssoProvider.providerId, providerId));
                // A site's provider with no site behind it signs no one in.
                if (!p?.siteId) return false;
                siteId = p.siteId;
              }
            } else if (path.startsWith('/device/token')) via = 'device';
            return { data: { ...session, via, siteId } };
          },
        },
      },
    },
    plugins,
  });
}

export type Auth = ReturnType<typeof createAuth>;
