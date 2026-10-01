/**
 * Shared checks for the console's pages and form actions: who's signed in,
 * which site, what they may do, and turning a broken rule into a message.
 */
import { error, fail, type RequestEvent, redirect } from '@sveltejs/kit';
import { siteApp } from './context.ts';
import {
  type Actor,
  canManage,
  managerSessionProblem,
  membership,
  SiteError,
  sessionProblem,
  siteBySlug,
} from './model.ts';

export function requireActor(event: Pick<RequestEvent, 'locals' | 'url'>): Actor {
  const actor = event.locals.actor;
  if (!actor)
    redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
  return actor;
}

/** The site in the URL and the signed-in person's standing in it. */
export async function siteContext(
  event: Pick<RequestEvent, 'locals' | 'url' | 'params'>,
  options: { allowOutsiders?: boolean } = {},
) {
  const app = await siteApp();
  const actor = requireActor(event);
  const user = actor.user;
  const site = await siteBySlug(app.ctx, event.params.site ?? '');
  if (!site) error(404, "There's no site with that ID.");
  const problem = sessionProblem(site, actor);
  if (problem) error(403, problem);
  const m = await membership(app.ctx, site, user);
  if (!options.allowOutsiders && !m && !user.switchbackManager)
    error(403, `You aren't a member of ${site.name}.`);
  return { app, actor, user, site, membership: m, manager: canManage(m, user) };
}

export function requireManager(manager: boolean): void {
  if (!manager) error(403, 'Only operators and admins can see this.');
}

/** Harville Labs staff only: the /admin console and its actions. */
export async function requireSwitchbackManager(
  event: Pick<RequestEvent, 'locals' | 'url'>,
): Promise<Actor> {
  const actor = requireActor(event);
  const problem = managerSessionProblem((await siteApp()).ctx, actor);
  if (problem) error(403, problem);
  return actor;
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
  next?.startsWith('/') && !next.startsWith('//') ? next : '/sites';
