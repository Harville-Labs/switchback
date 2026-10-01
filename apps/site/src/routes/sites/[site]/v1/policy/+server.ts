import { policy } from '$lib/server/api';
import { siteApp } from '$lib/server/context';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, request }) =>
  policy(await siteApp(), params.site, request);
