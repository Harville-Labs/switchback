# 0012: Harness managers and site operators

**Status:** Accepted · 2026-09-28 · Amends [0010](0010-hosted-sites.md) · Storage of roles amended by [0013](0013-site-auth-with-better-auth.md)

## Context

ADR 0010 gave each site `owner`, `admin`, and `member` roles and called Harville Labs staff "operators". Owners could appoint other owners, so Harville Labs had no say over who was in charge of a customer's site, and "operator" meant our own staff rather than the person running a site for their company. Harville Labs needs to see every site and decide who runs each one, while each company still runs its own site day to day.

## Decision

- **Harness managers** are Harville Labs staff (`users.harness_manager`). They see and can act on every site without holding a membership or a seat, create sites, set seat counts, assign and remove site operators, see telemetry across sites, and add or remove other Harness managers. Nobody can remove their own manager access, so one always remains. `MANAGER_EMAILS` grants it at startup. Changes to the manager list go in an audit log that isn't tied to any site.
- A site's roles are `operator`, `admin`, and `member`. `operator` replaces `owner`: it is Harville Labs' point of contact at the company and has every in-site permission. Only a Harness manager can make someone an operator, change an operator's role, or remove an operator. Operators and admins manage everything else: members and admins, policy, devices, and settings. A site always keeps at least one operator.
- Creating a site names its first operator. Assigning an operator promotes an existing member in place; anyone else is invited and takes a seat like any invitation.
- Migration `0001_harness_managers` renames `users.operator` to `users.harness_manager` and turns every `owner` membership into `operator`.

## Consequences

- A customer can't appoint or remove its own operators, so changing who runs a site goes through Harville Labs.
- Harness managers who aren't members don't count against seats, and the site console tells them they're viewing it as a manager.
- `OPERATOR_EMAILS` is now `MANAGER_EMAILS`. The site hadn't launched, so there is no fallback for the old name.
