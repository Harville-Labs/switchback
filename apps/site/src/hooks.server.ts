import type { Handle, ServerInit } from '@sveltejs/kit';
import { siteApp } from '$lib/server/context';
import { SESSION_COOKIE } from '$lib/server/guards';
import { sessionUser } from '$lib/server/model';

/** Open the database and apply migrations before the first request. */
export const init: ServerInit = async () => {
  await siteApp();
};

export const handle: Handle = async ({ event, resolve }) => {
  const app = await siteApp();
  event.locals.user = await sessionUser(app.ctx, event.cookies.get(SESSION_COOKIE));
  const response = await resolve(event);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'same-origin');
  return response;
};
