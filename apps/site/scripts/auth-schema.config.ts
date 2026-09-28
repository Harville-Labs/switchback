/**
 * Only for `bun run auth:schema`: Better Auth's CLI reads the plugins from an
 * `auth` instance to write src/lib/server/auth-schema.ts. Nothing connects.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { createAuth } from '../src/lib/server/auth.ts';
import { LogMailer } from '../src/lib/server/email.ts';

export const auth = createAuth({
  db: drizzle.mock() as never,
  publicUrl: 'http://localhost:8788',
  secret: 'schema-generation-only-not-a-secret-000000',
  mailer: new LogMailer(),
});
