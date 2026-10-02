# 0015: Role-based routing

**Status:** Accepted · 2026-10-01

## Context

Routing was built around two tiers: a `routing.local` chain and a `routing.remote` chain, with `mode` (`auto`, `local-only`, `remote-only`) choosing between them and escalation always moving from the first to the second. `escalation.via` (#58) added steps in between, and `review.model` could name any model, but the structure still said "local, then remote".

People use Switchback in more shapes than that: a fast local model escalating to a large local one, cheap remote escalating to expensive remote, fully local, fully remote, with a local or a remote reviewer, or several. What a model *does* (start turns, take escalations, review, run subagents) is independent of where it runs. Where it runs still matters, but for different reasons: cost, budgets, privacy, and an organization's remote-off switch.

## Decision

**Roles, filled by any model.** Configuration names roles, and each role lists model aliases. Whether a model is local or remote is a property of its provider and never of the role.

```jsonc
"routing": {
  "start":    ["fast", "fast-backup"],          // where turns begin: first up that fits
  "escalate": ["large", ["opus", "opus-aws"]],  // the ladder, one step per escalation
  "allowRemote": true                           // false: never call a remote model
},
"review":    { "mode": "auto", "models": ["large", "opus"] },
"subagents": { "model": "fast" }
```

- **`routing.start`** is a chain: alternatives, the first reachable model whose context window fits.
- **`routing.escalate`** is a ladder. Each step is an alias or a chain of aliases (fallbacks across providers for the same step). Each escalation moves one step from where the session is, and stickiness keeps it on the step it reached. Context overflow goes to the first step that fits.
- **`review.models`** is a review ladder. The first reviewer reviews; if its findings still stand after one fix, the next reviewer takes over. A model never reviews a turn it edited.
- **`subagents.model`** is the default for subagents that don't pin a model.
- **Tier is a filter, not a structure.** `/local` and `/remote` (and agent `route: local|remote`) mean "only models of that tier, in role order". Budgets, `ask` prompts, privacy, and remote-off apply to remote models wherever they appear in a role; local models are free and never prompt.
- **`allowRemote`** replaces `mode`. "Local only" is a configuration with only local models, or `allowRemote: false` to keep remote models configured but unused. An organization's remote-off restriction removes remote providers, as before.
- **Outages** fall back to the nearest other step that's up (higher first, then lower), subject to the same rules; `routing.fallback: "none"` turns that off.
- **The savings reference** is the first remote model in role order.

**Live changes.** A session can change its roles (`/start`, `/escalate`, `/review` in the TUI; pickers in VS Code) through a protocol method. Changes apply to that session, and can be saved to the user config. Keys an organization enforces can't be changed.

**Organizations.** Anyone can use any model in any role. Managing roles centrally (company defaults, enforced roles, restrictions) is what a Switchback site provides, through the existing `defaults` and `enforced` policy layers, which carry these keys like any other.

## Consequences

- A config rename with no fallback (pre-launch, as with the Switchback rename): `routing.local`, `routing.remote`, `routing.mode`, `escalation.via`, `fallback.onLocalUnavailable`/`onRemoteUnavailable`, and `review.model` are gone; old files fail validation with a message naming the replacement.
- The router stays pure (ADR 0004): role membership, the current step, and model tiers are all inputs.
- Setup asks for models first, then roles, with defaults filled in from what it found.
- Rejected: review triggered by diff size, and a parallel "all must approve" panel. Both can be added to `review` later without changing the ladder.
