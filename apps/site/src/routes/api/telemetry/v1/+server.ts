import { anonymousTelemetry } from '$lib/server/api';
import { siteApp } from '$lib/server/context';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) =>
  anonymousTelemetry(await siteApp(), request);
