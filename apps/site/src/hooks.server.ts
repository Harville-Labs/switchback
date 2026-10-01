import type { Handle, ServerInit } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
import { PUBLIC_AUTH_PATHS } from '$lib/server/auth';
import { siteApp } from '$lib/server/context';
import { actorFor } from '$lib/server/model';

/** Open the database and apply migrations before the first request. */
export const init: ServerInit = async () => {
  await siteApp();
};

const AUTH_BASE = '/api/auth';

export const handle: Handle = async ({ event, resolve }) => {
  const app = await siteApp();
  const path = event.url.pathname;
  // Browsers reach only the sign-in endpoints; every other Better Auth call
  // goes through the console's actions, which apply the site's rules first.
  if (path.startsWith(`${AUTH_BASE}/`)) {
    const rest = path.slice(AUTH_BASE.length);
    if (!PUBLIC_AUTH_PATHS.some((p) => p.test(rest)))
      return new Response('Not found', { status: 404 });
  }
  const actor = await actorFor(app.ctx, event.request.headers);
  // Device tokens are for the Switchback client's API, never the console.
  event.locals.actor = actor?.session.via === 'device' ? undefined : actor;
  event.locals.user = event.locals.actor?.user;
  const response = await svelteKitHandler({ event, resolve, auth: app.ctx.auth, building });
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'same-origin');
  return response;
};
