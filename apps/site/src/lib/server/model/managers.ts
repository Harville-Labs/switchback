/** Switchback managers (Harville Labs staff), who see and manage every site. */
import { eq } from 'drizzle-orm';
import { MANAGER } from '../auth.ts';
import * as t from '../schema.ts';
import { audit } from './audit.ts';
import { type Actor, authCall, type Ctx, email, SiteError, type User } from './core.ts';
import { ensureUser, toUser, userByEmail } from './people.ts';
import { assertSwitchbackManager } from './sites.ts';

export async function listSwitchbackManagers(ctx: Ctx): Promise<User[]> {
  const rows = await ctx.db
    .select()
    .from(t.user)
    .where(eq(t.user.role, MANAGER))
    .orderBy(t.user.email);
  return rows.map(toUser);
}

/**
 * Grant or revoke Switchback manager access, through Better Auth's admin plugin
 * as the acting manager. Nobody can revoke their own, so there's always
 * someone left who can. Addresses in MANAGER_EMAILS are granted again at
 * every startup.
 */
export async function setSwitchbackManager(
  ctx: Ctx,
  actor: Actor,
  emailInput: string,
  grant: boolean,
): Promise<User> {
  assertSwitchbackManager(actor.user, 'change who is a Switchback manager');
  const address = email(emailInput);
  if (!grant && address === actor.user.email)
    throw new SiteError("You can't remove your own Switchback manager access.");
  const user = grant ? await ensureUser(ctx, address) : await userByEmail(ctx, address);
  if (!user) throw new SiteError(`${address} isn't a Switchback manager.`, 404);
  await authCall(() =>
    ctx.auth.api.setRole({
      body: { userId: user.id, role: grant ? MANAGER : 'user' },
      headers: actor.headers,
    }),
  );
  // Revoked access ends the sessions that carried it.
  if (!grant) await ctx.db.delete(t.session).where(eq(t.session.userId, user.id));
  await audit(ctx, null, actor.user, grant ? 'manager.added' : 'manager.removed', user.email);
  return { ...user, switchbackManager: grant };
}
