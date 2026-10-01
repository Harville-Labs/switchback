# 0005: Claude Code-compatible agent definitions

**Status:** Accepted · 2026-09-26

## Context

Many prospective customers already maintain subagents in `.claude/agents/*.md` and project instructions in `CLAUDE.md` or `AGENTS.md`. Asking them to rewrite those is friction we don't need.

## Decision

- Agent files use Markdown with YAML frontmatter (`name`, `description`, `tools`, `model`), the same format Claude Code uses.
- We load `.claude/agents/` alongside our own `.switchback/agents/` (ours win on name conflicts).
- Claude Code tool names map to ours (`Read` → `read`, `Task` → `task`). `model: sonnet|opus|haiku|inherit` map to configurable model aliases, which mean medium/large/small on whichever provider the user chose ([ADR 0006](0006-provider-neutrality.md)).
- We extend the format only with optional fields (`route`, `model: local|remote`) that Claude Code ignores.
- Project instructions come from `AGENTS.md`, falling back to `CLAUDE.md`.

## Consequences

- An existing Claude Code setup works in Switchback on day one, and can move work to local models by adding `model: local`.
- Our format can't diverge incompatibly. New fields must be optional and safe to ignore.
