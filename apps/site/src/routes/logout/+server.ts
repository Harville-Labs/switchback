import { redirect } from '@sveltejs/kit';
import { siteApp } from '$lib/server/context';
import { SESSION_COOKIE } from '$lib/server/guards';
import { endSession } from '$lib/server/model';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies }) => {
  const session = cookies.get(SESSION_COOKIE);
  if (session) await endSession((await siteApp()).ctx, session);
  cookies.delete(SESSION_COOKIE, { path: '/' });
  redirect(303, '/login');
};
