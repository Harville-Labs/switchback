# 0013: Site authentication with Better Auth, and single sign-on per site

**Status:** Accepted · 2026-09-28 · Amends [0010](0010-hosted-sites.md) and [0012](0012-switchback-managers-and-site-operators.md)

## Context

The first version of the site wrote its own authentication: emailed sign-in links, web sessions, an RFC 8628 device flow, hashed rotating access and refresh tokens, and user codes. The CLI had its own polling loop for that flow. Authentication is where hand-written code fails worst, and the next requirement, single sign-on, adds OIDC: discovery, ID token validation, PKCE, and account linking. Customers also need SSO that can only sign people in to their own site, and Harville Labs staff need their own SSO for managing sites.

## Decision

- **The site uses [Better Auth](https://www.better-auth.com) for every credential.** Its plugins provide emailed sign-in links (`magicLink`), the device authorization grant (`deviceAuthorization`), bearer tokens for devices (`bearer`), staff roles (`admin`), sites with members and invitations (`organization`), and OIDC single sign-on with DNS domain verification (`@better-auth/sso`). Better Auth's CLI generates its tables (`bun run auth:schema`), which Drizzle migrates alongside ours. The site keeps no token, hash, or session code of its own.
- **Sites are Better Auth organizations.** A site operator is the organization's `owner` role, so the plugins' owner checks (SSO provider management among them) apply to operators. Seats are an organization field; members plus pending invitations can't exceed them. Switchback managers are the admin plugin's `manager` role, limited to seeing people and granting or revoking manager access (no impersonation).
- **Browsers reach two Better Auth endpoints**: the sign-in link target and the SSO callbacks. The console's server actions do everything else: they apply the site's own rules (only Switchback managers assign operators, a site keeps one, and the rest of ADR 0012), then call `auth.api` as the signed-in person, so the plugins check permissions too. Switchback managers act on sites they don't belong to, which the plugins don't model, so their membership changes are written directly.
- **Device sign-in** is Better Auth's device authorization grant behind the ADR 0007 endpoints, which now follow the OAuth RFCs: `POST /v1/device/code` and a single `POST /v1/token`, both taking form posts. The code carries the site as its scope, only a member can approve it on that site's page, and the token it becomes works only on that site's API, never in the console. Tokens are Better Auth sessions: they last 30 days and renew while in use, so there are no refresh tokens. The CLI runs the grant with `openid-client` instead of its own polling loop.
- **Single sign-on per site.** A site's operators and admins register their OIDC provider (issuer, client ID and secret, email domain) on the site's settings page. Nobody can sign in with it until a DNS TXT record proves the domain. On every SSO sign-in, a resolver running in Better Auth's transaction admits only addresses at that domain belonging to the site's members or invitees, and the session it creates is bound to that site. That session can't open another site or the manager console. An operator can then require SSO for the site; to avoid locking themselves out, they must be signed in through it to turn that on.
- **Harville Labs' own OIDC provider** (`STAFF_SSO_*`) signs in existing Switchback managers only. `MANAGER_SSO_REQUIRED=true` makes it the only way into `/admin`.
- The migrations restart from a single baseline, because no site had been deployed.

## Consequences

- Security fixes in sign-in, sessions, OAuth, and OIDC come from upgrading Better Auth and openid-client, not from our code.
- The site depends on Better Auth's table layout; `bun run auth:schema` regenerates it after an upgrade or plugin change.
- The CLI sends an `Origin` header with OAuth form posts, because SvelteKit's CSRF check rejects form posts without one and can't exempt a route.
- SAML isn't offered yet. The SSO plugin supports it, so adding it means a settings form and allowing the ACS endpoint.
