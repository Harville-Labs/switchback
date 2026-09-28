/**
 * The Harness client protocol (docs/organizations.md), served per site under
 * `/s/<site>/v1`, and anonymous telemetry at `/api/telemetry/v1`. Plain
 * Request → Response functions: the `+server.ts` routes call them, and tests
 * call them directly. Clients authenticate with their device's bearer token.
 */
import { z } from 'zod';
import type { SiteApp } from './context.ts';
import {
  addUsage,
  authenticateDevice,
  clientPolicy,
  pollDevice,
  refreshDevice,
  type Site,
  siteBySlug,
  startDeviceSignIn,
  storeTelemetry,
} from './model.ts';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

const bearer = (req: Request) =>
  req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || undefined;

async function body(req: Request): Promise<unknown> {
  return req.json().catch(() => undefined);
}

type Handler = (app: SiteApp, site: Site, req: Request) => Promise<Response>;

/** Resolve the site, or 404, before a handler runs. */
export function forSite(handler: Handler) {
  return async (app: SiteApp, slug: string, req: Request): Promise<Response> => {
    const site = await siteBySlug(app.ctx, slug);
    if (!site) return json({ error: 'no_such_site' }, 404);
    return handler(app, site, req);
  };
}

export const deviceCode = forSite(async (app, site, req) => {
  const b = (await body(req)) as { client?: unknown } | undefined;
  const client = typeof b?.client === 'string' ? b.client.slice(0, 100) : undefined;
  const d = await startDeviceSignIn(app.ctx, site, client);
  const uri = `${app.publicUrl}/s/${site.slug}/device`;
  return json({
    device_code: d.deviceCode,
    user_code: d.userCode,
    verification_uri: uri,
    verification_uri_complete: `${uri}?code=${d.userCode}`,
    expires_in: d.expiresIn,
    interval: d.interval,
  });
});

export const deviceToken = forSite(async (app, site, req) => {
  const b = z.object({ device_code: z.string() }).safeParse(await body(req));
  if (!b.success) return json({ error: 'invalid_request' }, 400);
  const r = await pollDevice(app.ctx, site, b.data.device_code);
  return 'tokens' in r ? json(r.tokens) : json({ error: r.error }, 400);
});

export const tokenRefresh = forSite(async (app, site, req) => {
  const b = z.object({ refresh_token: z.string() }).safeParse(await body(req));
  if (!b.success) return json({ error: 'invalid_request' }, 400);
  const tokens = await refreshDevice(app.ctx, site, b.data.refresh_token);
  return tokens ? json(tokens) : json({ error: 'invalid_grant' }, 401);
});

export const policy = forSite(async (app, site, req) => {
  if (!(await authenticateDevice(app.ctx, site, bearer(req))))
    return json({ error: 'unauthorized' }, 401);
  const p = await clientPolicy(app.ctx, site);
  const etag = `"${String(p.version)}"`;
  if (req.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers: { etag } });
  return json(p, 200, { etag });
});

export const usage = forSite(async (app, site, req) => {
  const who = await authenticateDevice(app.ctx, site, bearer(req));
  if (!who) return json({ error: 'unauthorized' }, 401);
  const b = (await body(req)) as { entries?: unknown } | undefined;
  try {
    await addUsage(app.ctx, site, who.user, b?.entries);
  } catch {
    return json({ error: 'invalid_usage' }, 400);
  }
  return new Response(null, { status: 204 });
});

export const siteTelemetry = forSite(async (app, site, req) => {
  if (!(await authenticateDevice(app.ctx, site, bearer(req))))
    return json({ error: 'unauthorized' }, 401);
  try {
    await storeTelemetry(app.ctx, site, await body(req));
  } catch {
    return json({ error: 'invalid_report' }, 400);
  }
  return new Response(null, { status: 204 });
});

/** Installs that aren't signed in to a site and opted in to telemetry. */
export async function anonymousTelemetry(app: SiteApp, req: Request): Promise<Response> {
  try {
    await storeTelemetry(app.ctx, undefined, await body(req));
  } catch {
    return json({ error: 'invalid_report' }, 400);
  }
  return new Response(null, { status: 204 });
}
