# Switchback sites

Companies manage Switchback on **app.switchback.sh**, which Harville Labs hosts. Each company has a **site**, with seats, members, and the policy every member's Switchback follows. The design is recorded in [ADR 0010](adr/0010-hosted-sites.md); sign-in and single sign-on in [ADR 0013](adr/0013-site-auth-with-better-auth.md).

## For members

Your company's operator or an admin invites your work email. Accept the emailed invitation, signing in with that address, then connect Switchback:

```sh
switchback login --site acme      # your company's site ID
```

Your browser opens the site's sign-in page. Sign in (through your company's single sign-on if it has one, otherwise with an emailed link), check that the code matches the one in your terminal, and choose **Sign in**. The device stays signed in for 30 days after it was last used. From then on, the site's policy applies to the TUI, VS Code, and `switchback run` ([organizations.md](organizations.md) explains how). `switchback whoami` shows what it changes, and `switchback logout` signs out.

On the site you can see your own usage and the devices you've signed in, and sign any of them out.

## For operators and admins

| Page | What you can do |
|---|---|
| Overview | Remote spend, the share of calls on local models, and usage by model and member over 30 days |
| Members | Invite people by email as `member` or `admin`; change roles; cancel invitations; remove people. Removing someone frees their seat and signs out all their devices |
| Policy | Edit the policy JSON (`defaults`, `enforced`, `restrictions`, `refreshSeconds`; see [organizations.md](organizations.md#policy-format)). Each save is validated with the same schema Switchback uses and becomes a new version; restore any earlier version from the history |
| Devices | Every signed-in Switchback, with when it was last seen; sign out any of them |
| Settings | Whether members' Switchback sends usage statistics ([telemetry.md](telemetry.md)): on for everyone (default), each member's choice, or off. A member's `DO_NOT_TRACK` always wins. Also single sign-on (below) |
| Audit log | Every change to members, roles, policy, devices, and settings, with who made it |

**Roles.** Operators run the site for their company, and Harville Labs assigns them: ask your Switchback manager to add or change one. Operators and admins can do everything on the pages above. Members sign in Switchback and see their own usage and devices. A site always has at least one operator.

**Seats.** Harville Labs sets your seat count. Every member takes a seat, and so does every invitation until it's accepted, canceled, or expires (after 14 days). When all seats are taken, invitations are refused until you free one or add seats.

### Single sign-on

Operators and admins can connect the site to the company's OIDC identity provider (Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak, and others) under **Settings**:

1. In the identity provider, create an OIDC web application with the redirect URI the page shows (`https://app.switchback.sh/api/auth/sso/callback/site-<id>`).
2. Enter its issuer URL, client ID and secret, and your email domain.
3. Add the DNS TXT record the page shows (`_switchback-sso-site-<id>.<domain>`), then choose **Verify domain**. Until the domain is verified, nobody can sign in with the provider.

After that, anyone who enters an address at that domain on the sign-in page goes to your identity provider. It signs in only your site's members and invitees at that domain, and a session it creates works only on your site: not on any other site, and not for Harville Labs' management pages. Once you've signed in through it yourself, you can **require** it, which stops members using emailed links for your site. Switchback managers still reach your site through Harville Labs' own sign-in.

## What the site stores

Member email addresses and roles, invitations, sessions and device tokens (Better Auth's tables), your identity provider's issuer and client credentials if you use single sign-on, policy versions, daily usage per member and model (token counts and costs), the anonymous telemetry reports members' Switchback sends, and the audit log. Switchback never sends prompts, code, or file names, so the site never has them.

## For Switchback managers

Switchback managers are Harville Labs staff ([ADR 0012](adr/0012-switchback-managers-and-site-operators.md)). At `/admin` (**All sites** in the header) they:

- see every site, its operators, and its seats, and open any site's console without taking a seat;
- create sites (name, ID, seats, and first operator, who is emailed);
- on a site's page (`/admin/<id>`), assign operators (a member is promoted; anyone else is invited into a seat), make an operator an admin, remove one, and change the seat count. A site always keeps at least one operator;
- add and remove other Switchback managers (never themselves), with those changes logged; removing one signs them out everywhere;
- see telemetry across all sites and unaffiliated installs: installs, local share of calls, remote spend and savings, routing rules, versions, and recent scrubbed crash reports.

Managers sign in with an emailed link, or with **Harville Labs staff** on the sign-in page when Harville Labs' identity provider is configured (`STAFF_SSO_*`). That provider signs in existing managers only; with `MANAGER_SSO_REQUIRED=true` it's the only way into `/admin`. A session from a customer's identity provider never reaches `/admin`, even for a manager.
