/**
 * The running site's dependencies, built once from the environment (see
 * docs/sites.md) and replaceable in tests.
 *
 *   PUBLIC_URL / ORIGIN      where it's served (adapter-node's ORIGIN wins)
 *   DATABASE_URL             postgres://…; required in production. Locally it defaults to
 *                            the `bun run db:up` container
 *   BETTER_AUTH_SECRET       signs sessions and cookies; required in production
 *   MANAGER_EMAILS           Harville Labs staff, made Harness managers at startup
 *   STAFF_SSO_ISSUER, STAFF_SSO_CLIENT_ID, STAFF_SSO_CLIENT_SECRET, STAFF_SSO_DOMAIN
 *                            Harville Labs' OIDC provider for managers (optional)
 *   MANAGER_SSO_REQUIRED     `true`: managers must sign in through it
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM   outgoing mail
 */

import { sveltekitCookies } from 'better-auth/svelte-kit';
import { z } from 'zod';
import { getRequestEvent } from '$app/server';
import { createAuth } from './auth.ts';
import { type Database, openDatabase } from './db.ts';
import { LogMailer, type Mailer, SmtpMailer } from './email.ts';
import { type Ctx, ensureUser } from './model.ts';

export interface SiteApp {
  ctx: Ctx;
  mailer: Mailer;
  /** e.g. https://harness.harville.ai, without a trailing slash. */
  publicUrl: string;
  /** Harville Labs' identity provider is configured. */
  staffSso: boolean;
}

const Env = z
  .object({
    NODE_ENV: z.string().optional(),
    ORIGIN: z.url().optional(),
    PUBLIC_URL: z.url().default('http://localhost:8788'),
    DATABASE_URL: z.string().optional(),
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    MANAGER_EMAILS: z.string().default(''),
    STAFF_SSO_ISSUER: z.url().optional(),
    STAFF_SSO_CLIENT_ID: z.string().optional(),
    STAFF_SSO_CLIENT_SECRET: z.string().optional(),
    STAFF_SSO_DOMAIN: z.string().default('harville.ai'),
    MANAGER_SSO_REQUIRED: z.stringbool().default(false),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().default(465),
    SMTP_USER: z.string().default('api_token'),
    SMTP_PASSWORD: z.string().optional(),
    EMAIL_FROM: z.string().default('Harness <harness@harville.ai>'),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV !== 'production') return;
    if (!e.DATABASE_URL)
      ctx.addIssue({
        code: 'custom',
        message: 'DATABASE_URL is required: the site keeps its data in Postgres.',
      });
    if (!e.BETTER_AUTH_SECRET)
      ctx.addIssue({
        code: 'custom',
        message: 'BETTER_AUTH_SECRET is required (32 or more random characters).',
      });
  });

/** The container from `bun run db:up` (compose.yaml). */
export const LOCAL_DATABASE_URL = 'postgres://harness:harness@localhost:5433/harness_site';
/** Development only; production refuses to start without BETTER_AUTH_SECRET. */
const DEV_SECRET = 'harness-site-development-secret-not-for-production';

let current: Promise<SiteApp> | undefined;
let database: Database | undefined;

async function fromEnv(env: Record<string, string | undefined>): Promise<SiteApp> {
  const e = Env.parse(env);
  database = await openDatabase(e.DATABASE_URL ?? LOCAL_DATABASE_URL);
  const publicUrl = (e.ORIGIN ?? e.PUBLIC_URL).replace(/\/+$/, '');
  const mailer: Mailer =
    e.SMTP_HOST && e.SMTP_PASSWORD
      ? new SmtpMailer({
          host: e.SMTP_HOST,
          port: e.SMTP_PORT,
          user: e.SMTP_USER,
          password: e.SMTP_PASSWORD,
          from: e.EMAIL_FROM,
        })
      : new LogMailer();
  const staffSso =
    e.STAFF_SSO_ISSUER && e.STAFF_SSO_CLIENT_ID && e.STAFF_SSO_CLIENT_SECRET
      ? {
          issuer: e.STAFF_SSO_ISSUER,
          clientId: e.STAFF_SSO_CLIENT_ID,
          clientSecret: e.STAFF_SSO_CLIENT_SECRET,
          domain: e.STAFF_SSO_DOMAIN,
        }
      : undefined;
  if (e.MANAGER_SSO_REQUIRED && !staffSso)
    throw new Error('MANAGER_SSO_REQUIRED needs STAFF_SSO_ISSUER, _CLIENT_ID, and _CLIENT_SECRET.');
  const auth = createAuth({
    db: database.db,
    publicUrl,
    secret: e.BETTER_AUTH_SECRET ?? DEV_SECRET,
    mailer,
    ...(staffSso ? { staffSso } : {}),
    // Cookies that `auth.api` calls set in form actions reach the browser.
    plugins: [sveltekitCookies(getRequestEvent)],
  });
  const ctx: Ctx = {
    db: database.db,
    auth,
    now: () => new Date(),
    managerSsoRequired: e.MANAGER_SSO_REQUIRED,
  };
  for (const address of e.MANAGER_EMAILS.split(',')
    .map((s) => s.trim())
    .filter(Boolean))
    await ensureUser(ctx, address, true);
  return { ctx, mailer, publicUrl, staffSso: Boolean(staffSso) };
}

export function siteApp(): Promise<SiteApp> {
  current ??= fromEnv(process.env);
  return current;
}

/** Tests: run against their own database and mailer. */
export function setSiteApp(app: SiteApp): void {
  current = Promise.resolve(app);
}

export async function closeSiteApp(): Promise<void> {
  await database?.close();
  database = undefined;
  current = undefined;
}
