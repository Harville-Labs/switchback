import { deviceCode } from '$lib/server/api';
import { siteApp } from '$lib/server/context';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) =>
  deviceCode(await siteApp(), params.site, request);
