import { error, redirect } from '@sveltejs/kit';
import { siteApp } from '$lib/server/context';
import { SESSION_COOKIE, safeNext } from '$lib/server/guards';
import { redeemLoginLink, SESSION_TTL_MS, SiteError } from '$lib/server/model';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const app = await siteApp();
  let r: Awaited<ReturnType<typeof redeemLoginLink>>;
  try {
    r = await redeemLoginLink(app.ctx, url.searchParams.get('token') ?? '');
  } catch (err) {
    if (err instanceof SiteError) error(400, err.message);
    throw err;
  }
  cookies.set(SESSION_COOKIE, r.session, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: url.protocol === 'https:',
    maxAge: SESSION_TTL_MS / 1000,
  });
  redirect(303, safeNext(r.next));
};
