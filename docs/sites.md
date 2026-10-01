# Harness sites

Companies manage Harness on **harness.harville.ai**, which Harville Labs hosts. Each company has a **site**, with seats, members, and the policy every member's Harness follows. The design is recorded in [ADR 0010](adr/0010-hosted-sites.md); sign-in and single sign-on in [ADR 0013](adr/0013-site-auth-with-better-auth.md).

## For members

Your company's operator or an admin invites your work email. Accept the emailed invitation, signing in with that address, then connect Harness:

```sh
harness login --site acme      # your company's site ID
```

Your browser opens the site's sign-in page. Sign in (through your company's single sign-on if it has one, otherwise with an emailed link), check that the code matches the one in your terminal, and choose **Sign in**. The device stays signed in for 30 days after it was last used. From then on, the site's policy applies to the TUI, VS Code, and `harness run` ([organizations.md](organizations.md) explains how). `harness whoami` shows what it changes, and `harness logout` signs out.

On the site you can see your own usage and the devices you've signed in, and sign any of them out.

## For operators and admins

| Page | What you can do |
|---|---|
| Overview | Remote spend, the share of calls on local models, and usage by model and member over 30 days |
| Members | Invite people by email as `member` or `admin`; change roles; cancel invitations; remove people. Removing someone frees their seat and signs out all their devices |
| Policy | Edit the policy JSON (`defaults`, `enforced`, `restrictions`, `refreshSeconds`; see [organizations.md](organizations.md#policy-format)). Each save is validated with the same schema Harness uses and becomes a new version; restore any earlier version from the history |
| Devices | Every signed-in Harness, with when it was last seen; sign out any of them |
| Settings | Whether members' Harness sends usage statistics ([telemetry.md](telemetry.md)): on for everyone (default), each member's choice, or off. A member's `DO_NOT_TRACK` always wins. Also single sign-on (below) |
| Audit log | Every change to members, roles, policy, devices, and settings, with who made it |

**Roles.** Operators run the site for their company, and Harville Labs assigns them: ask your Harness manager to add or change one. Operators and admins can do everything on the pages above. Members sign in Harness and see their own usage and devices. A site always has at least one operator.

**Seats.** Harville Labs sets your seat count. Every member takes a seat, and so does every invitation until it's accepted, canceled, or expires (after 14 days). When all seats are taken, invitations are refused until you free one or add seats.

### Single sign-on

Operators and admins can connect the site to the company's OIDC identity provider (Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak, and others) under **Settings**:

1. In the identity provider, create an OIDC web application with the redirect URI the page shows (`https://harness.harville.ai/api/auth/sso/callback/site-<id>`).
2. Enter its issuer URL, client ID and secret, and your email domain.
3. Add the DNS TXT record the page shows (`_harness-sso-site-<id>.<domain>`), then choose **Verify domain**. Until the domain is verified, nobody can sign in with the provider.

After that, anyone who enters an address at that domain on the sign-in page goes to your identity provider. It signs in only your site's members and invitees at that domain, and a session it creates works only on your site: not on any other site, and not for Harville Labs' management pages. Once you've signed in through it yourself, you can **require** it, which stops members using emailed links for your site. Harness managers still reach your site through Harville Labs' own sign-in.

## What the site stores

Member email addresses and roles, invitations, sessions and device tokens (Better Auth's tables), your identity provider's issuer and client credentials if you use single sign-on, policy versions, daily usage per member and model (token counts and costs), the anonymous telemetry reports members' Harness sends, and the audit log. Harness never sends prompts, code, or file names, so the site never has them.

## For Harness managers

Harness managers are Harville Labs staff ([ADR 0012](adr/0012-harness-managers-and-site-operators.md)). At `/admin` (**All sites** in the header) they:

- see every site, its operators, and its seats, and open any site's console without taking a seat;
- create sites (name, ID, seats, and first operator, who is emailed);
- on a site's page (`/admin/<id>`), assign operators (a member is promoted; anyone else is invited into a seat), make an operator an admin, remove one, and change the seat count. A site always keeps at least one operator;
- add and remove other Harness managers (never themselves), with those changes logged; removing one signs them out everywhere;
- see telemetry across all sites and unaffiliated installs: installs, local share of calls, remote spend and savings, routing rules, versions, and recent scrubbed crash reports.

Managers sign in with an emailed link, or with **Harville Labs staff** on the sign-in page when Harville Labs' identity provider is configured (`STAFF_SSO_*`). That provider signs in existing managers only; with `MANAGER_SSO_REQUIRED=true` it's the only way into `/admin`. A session from a customer's identity provider never reaches `/admin`, even for a manager.

### Running it

The app is `apps/site`: SvelteKit (Svelte 5), Better Auth, Drizzle ORM on Postgres, and Tailwind, checked with Biome and svelte-check. Better Auth handles every credential; browsers can reach only its sign-in link and SSO callback endpoints, and the console's server actions make every other call ([ADR 0013](adr/0013-site-auth-with-better-auth.md)).

```sh
cd apps/site
bun run db:up                                    # Postgres 18 in Docker, on localhost:5433
MANAGER_EMAILS=you@harville.ai bun run dev       # http://localhost:8788; sign-in links print to the console
bun run test                                     # tests, against a separate test database
```

Each site's console is at `/sites/<id>`; `/` goes to your sites, or to sign-in. The site also serves the installer at `/install.sh` from `scripts/install.sh`, so a change to the script ships with the next site image. Harness's public page is on harville.ai.

The site keeps every piece of data in Postgres, never in local storage ([ADR 0011](adr/0011-site-data-in-postgres-only.md)). `bun run db:down` stops the container and keeps its data; `docker compose down -v` deletes it.

| Variable | Default | |
|---|---|---|
| `ORIGIN` (or `PUBLIC_URL`) | `http://localhost:8788` | The URL people and clients use. Links, device URLs, and SvelteKit's cross-site form check depend on it |
| `DATABASE_URL` | the `db:up` container | A `postgres://` URL. Required in production; the app won't start without it |
| `BETTER_AUTH_SECRET` | a development value | Signs sessions and cookies; 32 or more random characters. Required in production |
| `MANAGER_EMAILS` | none | Comma-separated; made Harness managers at startup |
| `STAFF_SSO_ISSUER`, `STAFF_SSO_CLIENT_ID`, `STAFF_SSO_CLIENT_SECRET` | none | Harville Labs' OIDC provider for managers. Its redirect URI is `<ORIGIN>/api/auth/sso/callback/harville-labs` |
| `STAFF_SSO_DOMAIN` | `harville.ai` | Addresses that go to that provider from the sign-in page |
| `MANAGER_SSO_REQUIRED` | `false` | `true`: managers must sign in through Harville Labs' provider |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | none, 465, `api_token`, none | Outgoing mail. Production uses Cloudflare's SMTP service (`smtp.mx.cloudflare.net`); without a host and password, emails print to the log |
| `EMAIL_FROM` | `Harness <harness@harville.ai>` | |

After changing `src/lib/server/schema.ts`, or Better Auth's plugins or version (then run `bun run auth:schema` first, which regenerates `auth-schema.ts`), run `bun run db:generate` to write the migration; migrations apply at startup. The tests run single sign-on against a real OIDC provider ([oauth2-mock-server](https://github.com/axa-group/oauth2-mock-server)).

Point a Harness at a local site with `HARNESS_SITES_URL=http://localhost:8788 harness login --site acme`.

### Deploying it

CI builds `ghcr.io/harville-labs/harness-site` on every change to `main` (`.github/workflows/site-image.yml`) and pins the new tag in `deploy/k8s/site/kustomization.yaml`. Flux applies that directory from the homelab repository (`apps/harville-labs/harness-site`), which also holds the Ingress for `harness.harville.ai`, the CloudNativePG cluster and its backups, rate limits, `BETTER_AUTH_SECRET` (SOPS-encrypted), and `MANAGER_EMAILS`.
