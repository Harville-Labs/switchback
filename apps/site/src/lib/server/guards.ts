/**
 * Shared checks for the console's pages and form actions: who's signed in,
 * which site, what they may do, and turning a broken rule into a message.
 */
import { error, fail, type RequestEvent, redirect } from '@sveltejs/kit';
import { siteApp } from './context.ts';
import { canManage, membership, SiteError, siteBySlug, type User } from './model.ts';

export const SESSION_COOKIE = 'harness_session';

export function requireUser(event: Pick<RequestEvent, 'locals' | 'url'>): User {
  const user = event.locals.user;
  if (!user)
    redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
  return user;
}

/** The site in the URL and the signed-in person's standing in it. */
export async function siteContext(
  event: Pick<RequestEvent, 'locals' | 'url' | 'params'>,
  options: { allowOutsiders?: boolean } = {},
) {
  const app = await siteApp();
  const user = requireUser(event);
  const site = await siteBySlug(app.ctx, event.params.site ?? '');
  if (!site) error(404, "There's no site with that ID.");
  const m = await membership(app.ctx, site, user);
  if (!options.allowOutsiders && m?.status !== 'active' && !user.operator)
    error(403, `You aren't a member of ${site.name}.`);
  return { app, user, site, membership: m, manager: canManage(m, user) };
}

export function requireManager(manager: boolean): void {
  if (!manager) error(403, 'Only owners and admins can see this.');
}

/** Run a change; a broken rule becomes a form error instead of a crash. */
export async function attempt<T>(change: () => Promise<T>) {
  try {
    return await change();
  } catch (err) {
    if (err instanceof SiteError) return fail(err.status, { error: err.message });
    throw err;
  }
}

/** Only same-site paths, so a sign-in link can't send anyone elsewhere. */
export const safeNext = (next: string | null | undefined) =>
  next?.startsWith('/') && !next.startsWith('//') ? next : '/';
