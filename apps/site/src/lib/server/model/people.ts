/** People and sign-in: accounts, the signed-in actor, and where a sign-in link or SSO redirect goes. */
import { eq } from 'drizzle-orm';
import { MANAGER, STAFF_SSO } from '../auth.ts';
import * as t from '../schema.ts';
import { type Actor, authCall, type Ctx, email, type User } from './core.ts';

export const toUser = (r: typeof t.user.$inferSelect): User => ({
  id: r.id,
  email: r.email,
  name: r.name === r.email ? null : r.name,
  switchbackManager: r.role === MANAGER,
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
  if (manager && !user.switchbackManager) {
    await ctx.db.update(t.user).set({ role: MANAGER }).where(eq(t.user.id, user.id));
    user = { ...user, switchbackManager: true };
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
