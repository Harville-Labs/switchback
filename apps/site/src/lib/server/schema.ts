/**
 * The site's tables. Postgres in production (CloudNativePG); PGlite, which is
 * Postgres compiled to WebAssembly, in development and tests, so there's one
 * dialect everywhere. After changing this file, `bun run db:generate` writes
 * the migration.
 */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  /** Harville Labs staff. */
  operator: boolean('operator').notNull().default(false),
  createdAt: ts('created_at').notNull(),
});

export const sites = pgTable('sites', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  seats: integer('seats').notNull(),
  /** Members' telemetry: `on` / `off` (enforced), or `user` (their choice). */
  telemetry: text('telemetry', { enum: ['on', 'off', 'user'] })
    .notNull()
    .default('on'),
  createdAt: ts('created_at').notNull(),
});

export const memberships = pgTable(
  'memberships',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
    status: text('status', { enum: ['active', 'invited'] }).notNull(),
    invitedBy: text('invited_by'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.userId] })],
);

export const loginLinks = pgTable('login_links', {
  tokenHash: text('token_hash').primaryKey(),
  email: text('email').notNull(),
  next: text('next'),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export const webSessions = pgTable('web_sessions', {
  idHash: text('id_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const deviceCodes = pgTable('device_codes', {
  codeHash: text('code_hash').primaryKey(),
  userCode: text('user_code').notNull().unique(),
  siteId: text('site_id')
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['pending', 'approved', 'denied', 'used'] }).notNull(),
  userId: text('user_id'),
  client: text('client'),
  expiresAt: ts('expires_at').notNull(),
  lastPollAt: ts('last_poll_at'),
});

export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    client: text('client'),
    accessHash: text('access_hash').notNull().unique(),
    accessExpiresAt: ts('access_expires_at').notNull(),
    refreshHash: text('refresh_hash').notNull().unique(),
    refreshExpiresAt: ts('refresh_expires_at').notNull(),
    createdAt: ts('created_at').notNull(),
    lastSeenAt: ts('last_seen_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('devices_by_member').on(t.siteId, t.userId)],
);

export const policies = pgTable(
  'policies',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.version] })],
);

export const usageDaily = pgTable(
  'usage_daily',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    date: text('date').notNull(),
    tier: text('tier', { enum: ['local', 'remote'] }).notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    calls: integer('calls').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    costUsd: doublePrecision('cost_usd').notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.userId, t.date, t.tier, t.provider, t.model] })],
);

export const telemetryReports = pgTable(
  'telemetry_reports',
  {
    installId: text('install_id').notNull(),
    day: text('day').notNull(),
    siteId: text('site_id').references(() => sites.id, { onDelete: 'set null' }),
    report: jsonb('report').notNull(),
    receivedAt: ts('received_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.installId, t.day] }), index('telemetry_by_day').on(t.day)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    detail: text('detail'),
    at: ts('at').notNull(),
  },
  (t) => [index('audit_by_site').on(t.siteId, t.at)],
);
