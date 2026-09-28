# 0010: Hosted, site-based control plane

**Status:** Accepted · 2026-09-28 · Storage amended by [0011](0011-site-data-in-postgres-only.md)

## Context

[ADR 0007](0007-organization-policy.md) defined a client-side contract for organization policy and left the server open: any server implementing a few endpoints works. Harville Labs sells Harness to companies and runs the management side itself. Customers shouldn't have to deploy anything to manage their seats, members, and policy, and Harville Labs needs usage and telemetry from every customer to support them and tune the product.

## Decision

- **One hosted, multi-tenant app** (`apps/site`), run by Harville Labs at `https://harness.harville.ai`. Customers don't self-host it.
- **Sites.** Each customer company has a *site*, identified by a slug. A site's server URL is `https://harness.harville.ai/s/<slug>`, and it implements the ADR 0007 contract unchanged under that prefix, so existing clients work: `harness login --server https://harness.harville.ai/s/acme`, or the shorthand `harness login --site acme`.
- **People.** A user is a global identity (an email address). A **membership** links a user to a site with a **role**:
  - `owner`: everything, including managing admins and other owners;
  - `admin`: members, policy, devices, and usage;
  - `member`: signs in to Harness and sees their own devices and usage.

  A person can belong to several sites. Harville Labs staff are **operators**: they create sites, set seat counts, and see telemetry across sites.
- **Seats.** A site has a number of seats set by Harville Labs. Every active or invited membership takes one, so the limit is enforced when someone is invited: past it, invitations are refused until a member is removed or seats are added. Only active members can sign in a device.
- **Sign-in.** The web console uses email sign-in links. Harness clients use the existing device flow: the verification page is on the site, requires a web session and an active membership, and issues an opaque, revocable per-device token (stored hashed; access tokens last an hour, refresh tokens 30 days, rolling). Per-site SSO (OIDC, SAML) comes later and plugs into the same session layer.
- **Policy.** Admins edit the site's policy in the console. Every save is validated against `OrgPolicy` from `@harness/engine` (the same schema clients use) and stored as a new version; the history is kept and any version can be restored.
- **Telemetry and usage.** Signed-in clients send usage aggregates (`/v1/usage`) and telemetry reports (`/v1/telemetry`) to their site, so Harville Labs receives telemetry per site and each site's admins see their own usage. A site setting controls whether members' telemetry is on. It's applied as an enforced policy key, so members see it in `harness whoami`, and a member's `DO_NOT_TRACK` still wins. Installations not signed in to a site send telemetry, if they opted in, to `/api/telemetry/v1`.
- **Stack.** SvelteKit with Svelte 5 and the Node adapter, like harville.ai, formatted and linted with Biome. Drizzle ORM on Postgres: CloudNativePG in production, and PGlite (Postgres compiled to WebAssembly) in development and tests, so there's one SQL dialect everywhere and no database server to run locally. The client protocol handlers are plain `Request → Response` functions, tested directly with the real `OrgClient`. Email goes through Cloudflare's SMTP service (nodemailer). Every change an admin makes is written to a per-site audit log.
- **Deployment.** CI in this repo builds the image, and Flux deploys it to the Harville Labs cluster from the homelab repository, following its pattern for apps from external repositories: this repo holds the Deployment and Service (`deploy/k8s/site`), and the homelab repo holds the Ingress, the Postgres cluster and its backups, and configuration.

## Consequences

- The client protocol doesn't change; the site prefix is just part of the server URL. The dev server in `packages/engine/src/org/dev-server.ts` stays as the minimal reference implementation.
- Harville Labs operates a service holding customer policies, member emails, device tokens, and usage aggregates, but never prompts or code, since clients don't send them. That's a security boundary to review (#37).
- Seat enforcement happens on the server at invite and sign-in time; revoking a membership revokes its devices' tokens, and clients lose policy updates on their next refresh.
