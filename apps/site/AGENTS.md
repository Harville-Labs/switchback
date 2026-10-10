# AGENTS.md: apps/site

The hosted console at app.switchback.sh, where companies manage Switchback for their team. The [root AGENTS.md](../../AGENTS.md) applies here too; this file adds what's specific to the site. User-facing behavior and environment variables are documented in [docs/sites.md](../../docs/sites.md); the design is in ADRs [0010](../../docs/adr/0010-hosted-sites.md) through [0013](../../docs/adr/0013-site-auth-with-better-auth.md).

**This app is proprietary** ([LICENSE](LICENSE), [ADR 0014](../../docs/adr/0014-open-core-licensing.md)). Nothing under `packages/` or the other apps may import from it, and outside contributions to it can't be accepted.

## Commands

Run from `apps/site`:

```sh
bun run db:up                                  # Postgres 18 in Docker on localhost:5433 (dev + test databases)
MANAGER_EMAILS=you@harville.ai bun run dev     # http://localhost:8788; sign-in links print to the console
bun run test                                   # tests against the test database (wiped before each test)
bun run check                                  # svelte-kit sync + svelte-check
bun run build                                  # production build
bun run db:generate                            # write a migration after changing schema.ts
bun run auth:schema                            # regenerate auth-schema.ts after changing Better Auth plugins or version
bun run db:down                                # stop Postgres, keep data
```

The root `bun run check` runs this app's `check`. CI also runs `bun test` with a Postgres service, so the site's tests run there; locally they skip with a warning unless the database is up.

## Layout

| Path | Owns | Must not |
|---|---|---|
| `src/lib/server/model/` | Every domain rule, one module per area: people, sites, members, managers, SSO, devices, policy, usage and telemetry, the audit log. `model.ts` re-exports what routes may use | Know about HTTP or SvelteKit |
| `src/lib/server/api.ts` | The Switchback client protocol (`/sites/<site>/v1/...`) and anonymous telemetry, as plain `Request → Response` functions | Hold rules that belong in `model.ts` |
| `src/lib/server/auth.ts` | Better Auth configuration and plugins | Contain token, hash, or session code of our own |
| `src/lib/server/auth-schema.ts` | Better Auth's tables | Be edited by hand (`bun run auth:schema` generates it) |
| `src/lib/server/schema.ts` | Our Drizzle tables | Change without a migration |
| `src/lib/server/guards.ts` | Who's signed in, which site, what they may do | Be bypassed by a page or action |
| `src/lib/server/context.ts` | The app's dependencies, built once from the environment | Be skipped: nothing else reads `process.env` |
| `src/routes/` | Thin pages, form actions, and `+server.ts` wrappers that call `model.ts` / `api.ts` | Contain domain rules |
| `drizzle/` | Generated SQL migrations, applied at startup | Be edited by hand |

## Invariants

1. **Postgres only** ([ADR 0011](../../docs/adr/0011-site-data-in-postgres-only.md)). Every piece of data lives in the external Postgres. No embedded database, on-disk state, or in-memory store that must survive a restart.
2. **Better Auth handles every credential** ([ADR 0013](../../docs/adr/0013-site-auth-with-better-auth.md)). Browsers reach only its sign-in link and SSO callback endpoints; console server actions make every other call through `ctx.auth.api` as the signed-in person, so the plugins check permissions as well as our rules.
3. **Sessions stay on their site.** A session from a customer's SSO provider works only on that site, never on another site or `/admin`. A device token works only on its site's API, never in the console.
4. **Restrictions only remove.** Site policy is validated with the same schema the engine uses (`@harville-labs/switchback-org/policy`) and can only take capabilities away from clients. The site and the engine must agree on the schema, so change it in `packages/org`.
5. **Every change to members, roles, policy, devices, or settings writes an audit entry** with who made it.
6. **A site always has at least one operator**, and members plus pending invitations never exceed seats.
7. **No prompts, code, or file names.** Switchback never sends them, and the site has no field for them. Usage is daily token counts and costs per member and model; telemetry is anonymous.
8. **Strict CSP.** The CSP is `self`-only, so fonts and assets are bundled (`@fontsource`), never loaded from a CDN.

## How to make common changes

**Add a console page or action.** Add the route under `src/routes/sites/[site]/`. In `+page.server.ts`, call `siteContext()` from `guards.ts` first, then a function from `model.ts`. Put the rule (and its audit entry) in the matching module under `model/`, export it from `model.ts`, and test it in `site.test.ts`. Pages style with Tailwind utilities on the shared tokens in `src/app.css`.

**Add a table or column.** Edit `src/lib/server/schema.ts`, run `bun run db:generate`, commit the generated migration in `drizzle/`, and cover the new data in a test.

**Change Better Auth plugins or upgrade it.** Better Auth is pinned exactly so the schema generator matches. Bump `better-auth` and `@better-auth/sso` together, run `bun run auth:schema`, then `bun run db:generate`, then the full test suite (SSO tests run against `oauth2-mock-server`).

**Change the client protocol.** The protocol is shared with the engine's `OrgClient` (`packages/org/src/client.ts`). Change both in the same PR, document it in [docs/organizations.md](../../docs/organizations.md), and add a test in `site.test.ts` that drives the endpoint with the real `OrgClient`.

**Add an environment variable.** Read it in `context.ts`, validate it, fail at startup in production if it's required, and add it to the table in [docs/sites.md](../../docs/sites.md). Production values are set in the homelab repository; secrets there are SOPS-encrypted.

## Deployment

`.github/workflows/site-image.yml` builds `ghcr.io/harville-labs/switchback-site` when `apps/site`, the policy or telemetry schemas, the install scripts, or `bun.lock` change on `main`, then pins the tag in `deploy/k8s/site/kustomization.yaml`. Don't edit that tag by hand. Flux applies it from the homelab repository (`apps/harville-labs/switchback-site`), which owns the Ingress, CloudNativePG cluster, backups, rate limits, and secrets. Build the image from the repository root: `docker build -f apps/site/Dockerfile .`.

## Things not to do

- Don't hand-write auth: no custom tokens, password or token hashing, session tables, or OAuth flows.
- Don't put rules in routes; tests exercise `model.ts`, not pages.
- Don't add a client-side fetch to anything but Better Auth's two browser endpoints; use form actions.
- Don't point `TEST_DATABASE_URL` at a database with real data. Tests wipe it.
- Don't load fonts, scripts, or styles from third-party origins.
