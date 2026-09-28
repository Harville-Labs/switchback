import { tokenRefresh } from '$lib/server/api';
import { siteApp } from '$lib/server/context';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) =>
  tokenRefresh(await siteApp(), params.site, request);
