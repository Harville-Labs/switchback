/**
 * The Harness client protocol (docs/organizations.md), served per site under
 * `/sites/<site>/v1`, and anonymous telemetry at `/api/telemetry/v1`. Plain
 * Request → Response functions: the `+server.ts` routes call them, and tests
 * call them directly. Sign-in is Better Auth's device authorization grant
 * (RFC 8628); clients then send the token it issues as a bearer token.
 */
import type { SiteApp } from './context.ts';
import {
  addUsage,
  authenticateDevice,
  clientPolicy,
  finishDeviceSignIn,
  OAuthError,
  type Site,
  siteBySlug,
  startDeviceSignIn,
  storeTelemetry,
} from './model.ts';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

async function body(req: Request): Promise<unknown> {
  return req.json().catch(() => undefined);
}

/** OAuth endpoints take form posts (RFC 6749 section 4.1.3); JSON works too. */
async function params(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded'))
    return Object.fromEntries(new URLSearchParams(await req.text()));
  const b = await body(req);
  return b && typeof b === 'object'
    ? Object.fromEntries(
        Object.entries(b).filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    : {};
}

async function oauth(run: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await run());
  } catch (err) {
    if (err instanceof OAuthError)
      return json(
        { error: err.error, ...(err.description ? { error_description: err.description } : {}) },
        err.status,
      );
    throw err;
  }
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
  const p = await params(req);
  return oauth(() => startDeviceSignIn(app.ctx, site, app.publicUrl, p.client_id));
});

export const deviceToken = forSite(async (app, site, req) => {
  const p = await params(req);
  return oauth(() => finishDeviceSignIn(app.ctx, site, p, req.headers));
});

export const policy = forSite(async (app, site, req) => {
  if (!(await authenticateDevice(app.ctx, site, req.headers)))
    return json({ error: 'unauthorized' }, 401);
  const p = await clientPolicy(app.ctx, site);
  const etag = `"${String(p.version)}"`;
  if (req.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers: { etag } });
  return json(p, 200, { etag });
});

export const usage = forSite(async (app, site, req) => {
  const user = await authenticateDevice(app.ctx, site, req.headers);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const b = (await body(req)) as { entries?: unknown } | undefined;
  try {
    await addUsage(app.ctx, site, user, b?.entries);
  } catch {
    return json({ error: 'invalid_usage' }, 400);
  }
  return new Response(null, { status: 204 });
});

export const siteTelemetry = forSite(async (app, site, req) => {
  if (!(await authenticateDevice(app.ctx, site, req.headers)))
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
