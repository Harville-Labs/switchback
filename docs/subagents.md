# Agents and subagents

An **agent** is a system prompt, a tool allowlist, and a routing preference. The same definition can drive a whole session (the primary agent) or run as a **subagent** that the primary agent delegates to through the `task` tool.

## Why subagents matter here

Subagents are both a quality feature and a cost feature:

- **Context isolation.** A subagent reads fifty files and returns a ten-line summary. The parent's context, and the size of every later remote call, stays small.
- **Parallelism.** Several `task` calls in one response run concurrently, up to `subagents.maxConcurrent` per depth level.
- **Per-agent routing.** Each subagent has its own routing. The built-in `explore` agent is pinned to `local`, so broad codebase searches never cost anything, even when the parent is running on a remote model.

## Built-in agents

| Agent | Tools | Routing | Use |
|---|---|---|---|
| `build` | all | auto | Default primary agent for coding work |
| `explore` | read, glob, grep | **local** | Find files, symbols, and usages; returns a summary |
| `plan` | read, glob, grep | auto | Produce an implementation plan without editing |
| `general` | all | auto | Delegated multi-step tasks |

## Defining agents

Agents are Markdown files with YAML frontmatter. The format is compatible with Claude Code, so existing `.claude/agents/*.md` files load unchanged.

```markdown
---
name: reviewer
description: Reviews a diff for correctness bugs. Use after making changes.
tools: Read, Grep, Glob, Bash
model: sonnet
---
You are a code reviewer. Look for bugs that would cause incorrect behavior...
```

| Field | Values | Notes |
|---|---|---|
| `name` | string | Defaults to the file name |
| `description` | string, required | Shown to the parent agent to decide when to delegate. Write it as "what + when". |
| `tools` | comma list or YAML list | Claude Code names (`Read`, `Grep`, `Bash`, `Task`, ...) and harness names (`read`, `grep`, ...) both work. MCP tools use Claude Code's names: `mcp__github` allows every tool from that server, `mcp__github__create_issue` just one. Omit for all tools, including every MCP tool. |
| `model` | `local`, `remote`, `inherit`, or a model alias (`haiku`, `sonnet`, `opus`, or any key under `models` in config) | `local`/`remote` pin a tier; an alias pins a model; `inherit` or omitted defers to routing |
| `route` | `auto`, `local`, `remote` | Harness extension; same effect as `model: local`/`remote` |

The body is the system prompt. Harness appends an environment section and the project's `AGENTS.md` (or `CLAUDE.md`) to it.

### Lookup order

Later locations override earlier ones by name:

1. Built-ins
2. `~/.config/harness/agents/*.md` (user)
3. `.claude/agents/*.md` (Claude Code compatibility)
4. `.harness/agents/*.md` (project)

Files that fail to parse are skipped and reported by `harness doctor` and at startup. They never prevent the engine from starting.

### Model aliases

Claude Code agents use `model: opus|sonnet|haiku`. In Harness these mean the large, medium, and small model of the remote provider you chose in `harness init`, whether that's Anthropic, OpenAI, DeepSeek, or another. So a `.claude/agents` file with `model: haiku` runs on `gpt-6-luna` or `deepseek-flash` just as well as on Claude Haiku. See [providers.md](providers.md#model-aliases-are-tiers) for the mapping, and point any alias at any model in config. An alias that isn't configured is ignored and normal routing applies.

## The `task` tool

```json
{ "agent": "explore", "description": "find auth middleware", "prompt": "Find where HTTP auth is enforced..." }
```

- The subagent starts with an empty transcript. `prompt` has to be self-contained, because the subagent can't see the parent conversation.
- Only the subagent's final text returns to the parent. Its tool calls are visible to the user (clients show them nested under the task) but not to the parent model.
- A subagent that fails or is cancelled returns an error result, which the parent can handle.
- Cancelling the parent turn cancels its subagents.

## Limits

| Config | Default | Effect |
|---|---|---|
| `subagents.maxConcurrent` | 4 | Concurrent subagents per depth level. Extra calls queue. |
| `subagents.maxDepth` | 2 | Agents at this depth don't get the `task` tool. |
| `maxStepsPerTurn` | 50 | Applies to each subagent turn too. |

## Patterns

- **Search locally, decide remotely.** Keep the primary agent on `auto`. Have it delegate "find X" to `explore` (local) and make decisions with the summary.
- **Fan out reviews.** Define `security-reviewer`, `perf-reviewer`, and `test-reviewer` with `model: sonnet` and ask the primary agent to run them in parallel.
- **Cheap bulk edits.** An agent with `model: local` and `tools: read, edit` can apply mechanical changes across many files at zero cost. The primary agent verifies afterwards.
