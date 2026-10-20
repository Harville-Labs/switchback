# 0022: Starting from another agent's setup

**Status:** Accepted · 2026-10-20 · Builds on [0016](0016-open-conventions.md)

## Context

People rarely come to Switchback with nothing set up. Someone who has used OpenCode already has providers, models, MCP servers, and permissions they chose, and re-entering them in `switchback init` is the first thing that slows them down. [ADR 0016](0016-open-conventions.md) keeps Switchback from reading another agent's files, and its consequences anticipate this: moving a setup over is a copy the user makes deliberately.

## Decision

- On a first run of setup (no Switchback config at the target yet), the first question is whether to start from another agent's setup. Only agents whose config is found on this machine are offered, and "No, start fresh" is always there. `switchback init --from <agent>` picks one unattended.
- The other agent's config is read once, during setup, at the person's request. What it becomes (setup answers, `mcpServers`, `permissions`) is shown in setup's usual preview before anything is written, and the rest of setup (roles, budgets, extra models) continues as normal.
- Nothing is read from those files afterwards. The result is ordinary Switchback config; changing the other agent's config later changes nothing here.
- Credentials are not copied. Keys written into the other agent's config or its credential store stay there; setup says which environment variables Switchback needs. `{env:NAME}` references carry over as they are.
- What can't be translated (agents, commands, plugins, providers Switchback doesn't have) is listed with a reason, not dropped silently.
- Permission patterns translate into Switchback rules. Where the two agents' precedence differs (OpenCode: the last matching pattern wins; Switchback: deny beats ask beats allow), the result is stricter, never looser.
- OpenCode is the first agent supported. Each agent is one entry in `HARNESSES` (`packages/engine/src/setup-flow/start-from.ts`) with a finder and a translator.

## Consequences

- A repository's `opencode.json` still doesn't configure Switchback on its own; it's read only when the person picks it during setup.
- Translators follow another product's format, so they need updating when that format changes. They live only in setup, so a stale one costs a missed setting, not runtime behavior.
