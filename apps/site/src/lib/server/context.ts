/**
 * The running site's dependencies, built once from the environment (see
 * docs/sites.md) and replaceable in tests.
 *
 *   PUBLIC_URL / ORIGIN   where it's served (adapter-node's ORIGIN wins)
 *   DATABASE_URL          postgres://…; required in production. Locally it defaults to
 *                         the `bun run db:up` container
 *   OPERATOR_EMAILS       Harville Labs staff, made operators at startup
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM   outgoing mail
 */
import { z } from 'zod';
import { type Database, openDatabase } from './db.ts';
import { LogMailer, type Mailer, SmtpMailer } from './email.ts';
import { type Ctx, ensureUser } from './model.ts';

export interface SiteApp {
  ctx: Ctx;
  mailer: Mailer;
  /** e.g. https://harness.harville.ai, without a trailing slash. */
  publicUrl: string;
}

const Env = z.object({
  ORIGIN: z.url().optional(),
  PUBLIC_URL: z.url().default('http://localhost:8788'),
  DATABASE_URL: z.string().optional(),
  OPERATOR_EMAILS: z.string().default(''),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(465),
  SMTP_USER: z.string().default('api_token'),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default('Harness <harness@harville.ai>'),
});

/** The container from `bun run db:up` (compose.yaml). */
export const LOCAL_DATABASE_URL = 'postgres://harness:harness@localhost:5433/harness_site';

let current: Promise<SiteApp> | undefined;
let database: Database | undefined;

async function fromEnv(env: Record<string, string | undefined>): Promise<SiteApp> {
  const e = Env.parse(env);
  if (!e.DATABASE_URL && env.NODE_ENV === 'production')
    throw new Error('DATABASE_URL is required: the site keeps its data in Postgres.');
  database = await openDatabase(e.DATABASE_URL ?? LOCAL_DATABASE_URL);
  const ctx: Ctx = { db: database.db, now: () => new Date() };
  for (const email of e.OPERATOR_EMAILS.split(',')
    .map((s) => s.trim())
    .filter(Boolean))
    await ensureUser(ctx, email, true);
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
  return { ctx, mailer, publicUrl: (e.ORIGIN ?? e.PUBLIC_URL).replace(/\/+$/, '') };
}

export function siteApp(): Promise<SiteApp> {
  current ??= fromEnv(process.env);
  return current;
}

/** Tests: run against an in-memory database and mailer. */
export function setSiteApp(app: SiteApp): void {
  current = Promise.resolve(app);
}

export async function closeSiteApp(): Promise<void> {
  await database?.close();
  database = undefined;
  current = undefined;
}
