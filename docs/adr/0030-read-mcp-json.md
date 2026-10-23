# 0030: Read a project's `.mcp.json`, and start project MCP servers without asking

**Status:** Accepted · 2026-10-22 · Supersedes the MCP part of [0016](0016-open-conventions.md)

## Context

[ADR 0016](0016-open-conventions.md) stopped Switchback reading `.mcp.json`, along with the rest of another agent's setup. Since then `.mcp.json` has become the file most MCP clients read for a repository's servers, not one product's convention. Repositories commit one so every contributor's agent gets the same servers. Making Switchback users copy it into `.switchback/config.json`, and keep the copy in sync, is friction with no benefit: the format is the `mcpServers` shape Switchback already uses.

Project MCP servers also waited for `switchback mcp trust`. That protects against a cloned repository running a command on the first session, but other clients such as OpenCode start a project's servers without asking, and the extra step made project servers feel broken. People who want the check should be able to keep it.

## Decision

- Switchback reads `mcpServers` from `.mcp.json` at the workspace root, as a project layer below `.switchback/config.json` and `.switchback/config.local.json`. Those can adjust a server from it (`permission`, `enabled`) or turn it off. Nothing else in the file is read, and it isn't read when the workspace is the home directory.
- `${NAME}` and `${NAME:-default}` in `.mcp.json` become `{env:NAME}`. A default applies only when the variable is unset.
- The file is shared with other tools, so a server Switchback can't run (an unknown `type`, a name with characters tool names can't hold) is skipped with a warning, and an unreadable file is ignored with a warning. Neither stops Switchback from starting.
- A project's MCP servers, from `.mcp.json` or `.switchback/`, start without trust by default. `requireMcpTrust: true` brings back the trust check for both. It can be set in the user config, on the command line, or by an organization. A project's config can turn it on but never off.
- Hooks keep their trust check. The rest of 0016 stands: no `CLAUDE.md`, `.claude/`, or other agent's agents, hooks, or rules.

## Consequences

- Opening a repository with a `.mcp.json` or project `mcpServers` runs the commands they name when a session starts, unless the user set `requireMcpTrust`. Tool calls to those servers still follow `permissions.mcp` (default `ask`).
- A repository that has only a `.mcp.json` still counts as unconfigured, so first-run setup still happens.
- If other clients extend `.mcp.json` in ways Switchback doesn't support, those servers are skipped with a warning, which `switchback doctor` shows.
