# 0007: Organization policy from a config server

**Status:** Accepted · 2026-09-26

## Context

Companies buying Harness need central control: which local and hosted models their people use, spending limits, the ability to turn off remote models for regulated code, and visibility into usage. Asking every developer to hand-edit config does not scale and cannot be relied on.

## Decision

- Users sign in with `harness login` (device-code flow against the org's server, or a token for CI). The server returns an **org policy**: `defaults` (a config layer under the user's), `enforced` (a layer over everything), and `restrictions` (post-merge removal: allowRemote, provider allowlists, org-only providers, budget caps).
- The policy is fetched with ETags, cached per user (0600), and applied by `loadConfig` for every command. Running engines poll and apply updates live through `Engine.applyConfig`, emitting `config.updated` to clients.
- The server contract is small and documented (docs/organizations.md), with a reference implementation in the engine package, so customers can self-host or we can offer it as a service.
- Usage is reported as daily per-model aggregates, never content.

## Consequences

- Enforcement is client-side and advisory against an adversarial user; hard guarantees come from routing hosted traffic through an org gateway and managed credential distribution. This is documented, not hidden.
- `applyConfig` makes live reconfiguration a supported engine operation, which also enables config-file hot reload later.
- Session "allow always" grants reset on config changes, and `deny` is checked before grants so enforced denials always win.
