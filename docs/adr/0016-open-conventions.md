# 0016: Open conventions, not another agent's

**Status:** Accepted · 2026-10-06 · Supersedes [0005](0005-claude-code-agent-compat.md)

## Context

[ADR 0005](0005-claude-code-agent-compat.md) made Switchback read Claude Code's setup: `.claude/agents/`, `CLAUDE.md`, `.mcp.json`, and Claude's tool and model names. That ties Switchback's behavior to another product's conventions, which change on that product's schedule. It also lets a repository configured for one tool quietly configure another. Open conventions exist for most of this, and Switchback has its own `.switchback/` folder for the rest.

## Decision

- Project instructions come from `AGENTS.md` only, the open convention ([agents.md](https://agents.md)).
- Agents, MCP servers, hooks, permission rules, and (later) commands and skills are read only from Switchback's own locations: the user config directory and the project's `.switchback/`. Nothing is read from `.claude/`, `CLAUDE.md`, `.mcp.json`, or any other agent's files.
- Formats stay generic: agent files are Markdown with YAML frontmatter; MCP servers use the `mcpServers` shape most MCP clients share; tool names are Switchback's, matched case-insensitively.
- Model size aliases are `large`, `medium`, and `small`, not another vendor's model names.
- Integrations are separate from conventions. Running Claude Code as an external agent runtime ([ADR 0009](0009-external-agent-runtimes.md)) stays: it's a runtime the user opts into, and its own tool names are mapped where that runtime asks for permission.

## Consequences

- A repository set up for another agent doesn't change what Switchback does. Moving a setup over is a copy into `.switchback/`, which the user does deliberately.
- Switchback's formats can evolve without tracking anyone else's.
- Agent files that pinned `model: opus|sonnet|haiku` need `large|medium|small`, or a configured alias.
