# 0031: Config files can declare another tool's format

**Status:** Accepted · 2026-10-26 · Builds on [0016](0016-open-conventions.md) and [0022](0022-start-from-another-agent.md)

## Context

[ADR 0016](0016-open-conventions.md) keeps Switchback from reading another agent's files, and [ADR 0022](0022-start-from-another-agent.md) lets setup copy an OpenCode setup over once. Neither covers a team that keeps its agents and commands in a config written for OpenCode and wants Switchback to use the same file. They can put it at `.switchback/config.json`, so nothing about where Switchback looks changes. The file's own `$schema` says which format it's written in.

## Decision

- A Switchback config file may declare another tool's format with `$schema`. Switchback matches the URL against a registry of **dialects** (`packages/engine/src/dialects/`). A file with no `$schema`, or one that no dialect claims, is Switchback's own and is read as before.
- A dialect translates what it can into Switchback's keys before the file joins the config layers, and returns notes for what it left out. The result is validated and merged like any other layer, so everything that applies to config applies to it (trust, organization policy, `additive` rules and hooks). Notes show at startup and in `switchback doctor`, prefixed with the file and the dialect.
- OpenCode is the first dialect. It reads `agent`/`agents`, `command`/`commands`, `permission`/`permissions`, and `default_agent`. It doesn't read providers, models, or MCP servers, since they need choices only setup can make (an alias, where a key lives); the note points at `switchback init --from opencode`. An agent's `provider/model` reference can't become an alias, so it's dropped with a note; a bare alias carries over.
- Claude Code's settings format is the second dialect. Its permission rules and hook events are the ones Switchback's follow, so `permissions`, `hooks`, and `mcpServers` come over nearly as written, and project hooks and servers still wait for trust. Its agents and commands are Markdown files, not settings, so they stay where Switchback reads its own.
- The OpenCode translation is shared with setup, so `init --from opencode` and a config file with OpenCode's `$schema` read agents, commands, and permissions the same way.
- Adding a format means adding a dialect: a `$schema` matcher and a `translate` function. Nothing else changes.
- Switchback's own config accepts the fields these formats bring that it lacked, so a translation is lossless where the concepts match: an agent's `color` and `permissions` (a table, or OpenCode's list), a command's `subagent` and `agent`, and `system` and `steps` as other names for an agent's `prompt` and `maxSteps`.
- An agent's `permissions` can only tighten what the config allows: `ask` and `deny` levels and rules join the config's, and `allow` has no effect. An agent file in a cloned repository can't open up what the user closed. This is the `permissions` field [ADR 0029](0029-agents-and-permission-levels.md) proposes, without the rest of that record.

## Consequences

- A team can keep one config in OpenCode's format and use it in both tools. A file that's mostly OpenCode's still can't carry providers or MCP servers into Switchback; those stay in setup.
- A config's `$schema` now changes how the file is read. Editors that resolve it get OpenCode's schema for OpenCode's keys, and `bun run schema` keeps Switchback's for its own.
- Dialects read only files Switchback already reads. Nothing is read from `opencode.json`, `.claude/`, or any other tool's own files (ADR 0016 stands).
