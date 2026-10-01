# 0011: Site data lives only in external Postgres

**Status:** Accepted · 2026-09-28 · Amends [0010](0010-hosted-sites.md)

## Context

ADR 0010 ran the site on CloudNativePG in production but on PGlite, an embedded Postgres writing to a local directory, in development and tests. The site holds customer data that matters: which companies have access, who their members are, their policies, and the device tokens that sign Switchback in. That data has to live in a managed, replicated, backed-up database, and nothing in the app should be able to put it anywhere else, including through a missing environment variable in production.

## Decision

- The site talks only to an external Postgres through postgres.js. `openDatabase` rejects anything but a `postgres://` URL, and the app refuses to start in production without `DATABASE_URL`. There is no embedded or on-disk storage path.
- Production: the `switchback-site-postgres` CloudNativePG cluster in the homelab repo, with three instances, synchronous replication to at least one standby, WAL archiving, and nightly backups.
- Local development: a Postgres container from `apps/site/compose.yaml` (`bun run db:up`), which the app uses by default outside production.
- Tests: the same container's separate `switchback_site_test` database, or the Postgres service in CI (`TEST_DATABASE_URL`). The test database is wiped before each test. Without a database the site's tests skip with a message; CI always provides one.

## Consequences

- Developing on the site needs Docker (or any Postgres at `DATABASE_URL`).
- Development, tests, and production run the same database engine and driver, so what the tests pass is what production runs.
