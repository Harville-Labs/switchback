import { siteTelemetry } from '$lib/server/api';
import { siteApp } from '$lib/server/context';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) =>
  siteTelemetry(await siteApp(), params.site, request);
