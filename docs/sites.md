# Harness sites

Companies manage Harness on **harness.harville.ai**, which Harville Labs hosts. Each company has a **site**, with seats, members, and the policy every member's Harness follows. The design is recorded in [ADR 0010](adr/0010-hosted-sites.md).

## For members

Your admin invites your work email. Then:

```sh
harness login --site acme      # your company's site ID
```

Your browser opens the site's sign-in page. Sign in with the emailed link, check that the code matches the one in your terminal, and choose **Sign in**. From then on, the site's policy applies to the TUI, VS Code, and `harness run` ([organizations.md](organizations.md) explains how). `harness whoami` shows what it changes, and `harness logout` signs out.

On the site you can see your own usage and the devices you've signed in, and sign any of them out.

## For owners and admins

| Page | What you can do |
|---|---|
| Overview | Remote spend, the share of calls on local models, and usage by model and member over 30 days |
| Members | Invite people by email as `member`, `admin`, or `owner`; change roles; remove people. Removing someone frees their seat and signs out all their devices |
| Policy | Edit the policy JSON (`defaults`, `enforced`, `restrictions`, `refreshSeconds`; see [organizations.md](organizations.md#policy-format)). Each save is validated with the same schema Harness uses and becomes a new version; restore any earlier version from the history |
| Devices | Every signed-in Harness, with when it was last seen; sign out any of them |
| Settings | Whether members' Harness sends usage statistics ([telemetry.md](telemetry.md)): on for everyone (default), each member's choice, or off. A member's `DO_NOT_TRACK` always wins |
| Audit log | Every change to members, roles, policy, devices, and settings, with who made it |

**Roles.** Owners can do everything. Admins can do everything except add, change, or remove owners. Members sign in Harness and see their own usage and devices. A site always has at least one owner.

**Seats.** Harville Labs sets your seat count. Every member takes a seat, including invited people who haven't signed in yet. When all seats are taken, invitations are refused until you remove someone or add seats.

## What the site stores

Member email addresses and roles, policy versions, per-device tokens (as SHA-256 hashes only), daily usage per member and model (token counts and costs), the anonymous telemetry reports members' Harness sends, and the audit log. Harness never sends prompts, code, or file names, so the site never has them.

## For Harville Labs operators

Operators create sites (name, ID, seats, first owner; the owner is emailed), change seat counts, and see telemetry across all sites and unaffiliated installs at `/admin`: installs, local share of calls, remote spend and savings, routing rules, versions, and recent scrubbed crash reports.

### Running it

The app is `apps/site`: SvelteKit (Svelte 5), Drizzle ORM on Postgres, and Tailwind, checked with Biome and svelte-check.

```sh
cd apps/site
bun run db:up                                    # Postgres 18 in Docker, on localhost:5433
OPERATOR_EMAILS=you@harville.ai bun run dev      # http://localhost:8788; sign-in links print to the console
bun run test                                     # tests, against a separate test database
```

The site keeps every piece of data in Postgres, never in local storage ([ADR 0011](adr/0011-site-data-in-postgres-only.md)). `bun run db:down` stops the container and keeps its data; `docker compose down -v` deletes it.

| Variable | Default | |
|---|---|---|
| `ORIGIN` (or `PUBLIC_URL`) | `http://localhost:8788` | The URL people and clients use. Links, device URLs, and SvelteKit's cross-site form check depend on it |
| `DATABASE_URL` | the `db:up` container | A `postgres://` URL. Required in production; the app won't start without it |
| `OPERATOR_EMAILS` | none | Comma-separated; made operators at startup |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | none, 465, `api_token`, none | Outgoing mail. Production uses Cloudflare's SMTP service (`smtp.mx.cloudflare.net`); without a host and password, emails print to the log |
| `EMAIL_FROM` | `Harness <harness@harville.ai>` | |

After changing `src/lib/server/schema.ts`, run `bun run db:generate` to write the migration; migrations apply at startup.

Point a Harness at a local site with `HARNESS_SITES_URL=http://localhost:8788 harness login --site acme`.

### Deploying it

CI builds `ghcr.io/harville-labs/harness-site` on every change to `main` (`.github/workflows/site-image.yml`) and pins the new tag in `deploy/k8s/site/kustomization.yaml`. Flux applies that directory from the homelab repository (`apps/harville-labs/harness-site`), which also holds the Ingress for `harness.harville.ai`, the CloudNativePG cluster and its backups, rate limits, and `OPERATOR_EMAILS`.
