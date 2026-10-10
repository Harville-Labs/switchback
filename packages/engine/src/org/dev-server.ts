/**
 * Reference organization server for development and tests. Implements the
 * contract in docs/organizations.md with in-memory state:
 *
 * - device sign-in (RFC 8628): visiting the verification URL approves the code
 * - one token endpoint (RFC 6749) for the device code and refresh grants
 * - policy from a JSON file (re-read per request, so edits push immediately)
 *   or a function, served with an ETag
 * - usage reports kept in memory
 *
 *   bun packages/engine/src/org/dev-server.ts ./policy.json [port]
 *
 * Not for production: no real accounts, tokens don't expire.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { UsageAggregate } from '@harville-labs/switchback-org/client';

export interface DevOrgServerOptions {
  /** Policy JSON (without needing org/version, which are filled in) or a file path. */
  policy: Record<string, unknown> | string | (() => Record<string, unknown>);
  org?: { id: string; name: string };
  port?: number;
  /** Approve device codes without visiting the URL (tests). */
  autoApprove?: boolean;
}

export function startDevOrgServer(options: DevOrgServerOptions) {
  const org = options.org ?? { id: 'dev-org', name: 'Dev Org' };
  const devices = new Map<string, { userCode: string; approved: boolean }>();
  const tokens = new Set<string>();
  const usage: UsageAggregate[] = [];

  const policy = () => {
    const raw =
      typeof options.policy === 'function'
        ? options.policy()
        : typeof options.policy === 'string'
          ? (JSON.parse(readFileSync(options.policy, 'utf8')) as Record<string, unknown>)
          : options.policy;
    const body = { org, ...raw };
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
    return { body: { version: hash, ...body }, etag: `"${hash}"` };
  };

  const issueToken = () => {
    const token = `dev_${randomUUID()}`;
    tokens.add(token);
    return {
      access_token: token,
      token_type: 'Bearer',
      refresh_token: `refresh_${token}`,
      expires_in: 3600,
      org,
      user: { email: 'dev@example.com', name: 'Dev User' },
    };
  };
  const authorized = (req: Request) =>
    tokens.has(req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');

  const server = Bun.serve({
    port: options.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      switch (`${req.method} ${url.pathname}`) {
        case 'POST /v1/device/code': {
          const form = new URLSearchParams(await req.text());
          if (form.get('client_id') !== 'switchback')
            return Response.json({ error: 'invalid_client' }, { status: 400 });
          const deviceCode = randomUUID();
          const userCode =
            Math.random().toString(36).slice(2, 6).toUpperCase() +
            '-' +
            Math.random().toString(36).slice(2, 6).toUpperCase();
          devices.set(deviceCode, { userCode, approved: !!options.autoApprove });
          return Response.json({
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: `${url.origin}/device`,
            verification_uri_complete: `${url.origin}/device?user_code=${userCode}`,
            expires_in: 600,
            // Seconds; tests barely wait. A real server says 5.
            interval: options.autoApprove ? 0.01 : 1,
          });
        }
        case 'GET /device': {
          const code = url.searchParams.get('user_code');
          for (const d of devices.values()) if (d.userCode === code) d.approved = true;
          return new Response(
            `Approved ${code ?? '(no code)'} for ${org.name}. You can close this tab.`,
          );
        }
        case 'POST /v1/token': {
          const form = new URLSearchParams(await req.text());
          const grant = form.get('grant_type');
          if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
            const deviceCode = form.get('device_code') ?? '';
            const d = devices.get(deviceCode);
            if (!d) return Response.json({ error: 'expired_token' }, { status: 400 });
            if (!d.approved)
              return Response.json({ error: 'authorization_pending' }, { status: 400 });
            devices.delete(deviceCode);
            return Response.json(issueToken());
          }
          if (grant === 'refresh_token') {
            const refresh = form.get('refresh_token') ?? '';
            if (!tokens.has(refresh.replace(/^refresh_/, '')))
              return Response.json({ error: 'invalid_grant' }, { status: 400 });
            return Response.json(issueToken());
          }
          return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
        }
        case 'GET /v1/policy': {
          if (!authorized(req)) return new Response('unauthorized', { status: 401 });
          const p = policy();
          if (req.headers.get('if-none-match') === p.etag)
            return new Response(null, { status: 304 });
          return Response.json(p.body, { headers: { etag: p.etag } });
        }
        case 'POST /v1/usage': {
          if (!authorized(req)) return new Response('unauthorized', { status: 401 });
          const { entries } = (await req.json()) as { entries: UsageAggregate[] };
          usage.push(...entries);
          return new Response(null, { status: 204 });
        }
        default:
          return new Response('not found', { status: 404 });
      }
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    usage,
    /** Mint a token directly (tests, `switchback login --token`). */
    token: () => issueToken().access_token,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const [file, port] = Bun.argv.slice(2);
  if (!file) {
    console.error('usage: dev-server.ts <policy.json> [port]');
    process.exit(2);
  }
  const s = startDevOrgServer({ policy: file, port: Number(port) || 8787 });
  console.log(`dev org server on ${s.url}\n  switchback login --server ${s.url}`);
}
