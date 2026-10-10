# 0019: Switchback's own domains: switchback.sh and app.switchback.sh

**Status:** Accepted · 2026-10-09

## Context

Switchback lived under Harville Labs' domain: its page and docs at harville.ai/switchback, and the hosted console ([ADR 0010](0010-hosted-sites.md)) at switchback.harville.ai, which also served the installers and received telemetry. Harville Labs owns switchback.sh, and a product with its own name should have its own address. The website repository is becoming a monorepo with one site per product, so Switchback's page can move out of harville.ai.

No one runs a released build that depends on the old hosts yet, so this is the cheapest time to change the defaults built into the client.

## Decision

- **switchback.sh** is Switchback's site: the product page, the versioned docs at `/docs`, and the installers' short addresses, `switchback.sh/install.sh` and `switchback.sh/install.ps1`, which redirect to the console's copies. It's built in the Harville-Labs website (sites) repository as `apps/switchback`.
- **app.switchback.sh** is the console. It replaces switchback.harville.ai everywhere ADR 0010 and ADR 0014 name it: site server URLs are `https://app.switchback.sh/sites/<slug>`, `switchback login --site` uses it, and it is the default `telemetry.endpoint`. The contract in ADR 0007 is unchanged.
- The old addresses redirect permanently: harville.ai/switchback/** to the same path on switchback.sh, and switchback.harville.ai/** to app.switchback.sh. The redirects are in the website and homelab repositories.
- Sign-in emails still come from `switchback@harville.ai`; moving the sender needs mail DNS on switchback.sh first.

## Alternatives considered

- **Keep switchback.harville.ai for the console** and move only the page. It avoids touching the client, but leaves a customer's site under another company's name, and the change only gets more expensive once builds that hard-code it are in use.
- **The console at switchback.sh under path routing** (`/sites`, `/login`, `/api` to the console, the rest to the page). One host, but every new console route would need an Ingress change, and the page and the console would share cookies and a content security policy.

## Consequences

- An identity provider set up for a site's single sign-on has to have its redirect URI changed to `https://app.switchback.sh/api/auth/sso/callback/site-<id>`.
- Builds before this change send telemetry and sign-in to switchback.harville.ai and rely on the redirect.
