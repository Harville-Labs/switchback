/**
 * The database: Postgres (`postgres://…`, production) through postgres.js, or
 * PGlite (a directory, or `memory://` for tests), which is Postgres in
 * WebAssembly, so development needs no server. Migrations in ./drizzle are
 * applied at startup.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
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
  if (/^postgres(ql)?:\/\//.test(url)) {
    const client = postgres(url, { max: 10, onnotice: () => {} });
    const db = drizzlePostgres(client, { schema });
    await migratePostgres(db, { migrationsFolder: migrations });
    return { db: db as unknown as Db, close: () => client.end() };
  }
  // Loaded only when used, and not bundled (it reads its WebAssembly files from its package):
  // production runs on Postgres, and the container image doesn't include it.
  const [{ PGlite }, { drizzle: drizzlePglite }, { migrate: migratePglite }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
    import('drizzle-orm/pglite/migrator'),
  ]);
  const memory = url === 'memory://';
  // PGlite creates its own directory but not the ones above it (a fresh checkout has no .data/).
  if (!memory) mkdirSync(dirname(resolve(url)), { recursive: true });
  const client = new PGlite(memory ? undefined : url);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: migrations });
  return { db: db as unknown as Db, close: () => client.close() };
}
