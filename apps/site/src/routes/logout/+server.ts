import { redirect } from '@sveltejs/kit';
import { siteApp } from '$lib/server/context';
import { signOut } from '$lib/server/model';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  await signOut((await siteApp()).ctx, request.headers);
  redirect(303, '/login');
};
