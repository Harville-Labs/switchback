/**
 * The database: Postgres, always. Production runs on the cluster's
 * CloudNativePG cluster; local development and tests run against a Postgres
 * container (`bun run db:up`). The site never keeps data in embedded or
 * on-disk storage of its own. Migrations in ./drizzle are applied at startup.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.ts';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: Db;
  close(): Promise<void>;
}

/**
 * Where the migrations are: next to the source in development and tests,
 * `./drizzle` beside the built server (see Dockerfile), or `MIGRATIONS_DIR`.
 */
export function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const fromSource = fileURLToPath(new URL('../../../drizzle', import.meta.url));
  return existsSync(join(fromSource, 'meta')) ? fromSource : resolve('drizzle');
}

export async function openDatabase(url: string, migrations = migrationsDir()): Promise<Database> {
  if (!/^postgres(ql)?:\/\//.test(url))
    throw new Error(
      'DATABASE_URL must be a postgres:// URL. For local development, `bun run db:up` starts one (see docs/sites.md).',
    );
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrations });
  return { db: db as unknown as Db, close: () => client.end() };
}
