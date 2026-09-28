import { deviceToken } from '$lib/server/api';
import { siteApp } from '$lib/server/context';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) =>
  deviceToken(await siteApp(), params.site, request);
