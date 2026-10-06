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

Agents are Markdown files with YAML frontmatter in `.switchback/agents/` (the project) or `~/.config/switchback/agents/` (you). Switchback doesn't read other agents' folders ([ADR 0016](adr/0016-open-conventions.md)); to reuse an agent written for another tool, copy it into one of these and adjust it.

```markdown
---
name: reviewer
description: Reviews a diff for correctness bugs. Use after making changes.
tools: read, grep, glob, bash
model: medium
---
You are a code reviewer. Look for bugs that would cause incorrect behavior...
```

| Field | Values | Notes |
|---|---|---|
| `name` | string | Defaults to the file name |
| `description` | string, required | Shown to the parent agent to decide when to delegate. Write it as "what + when". |
| `tools` | comma list or YAML list | Tool names (`read`, `grep`, `bash`, `task`, ...), case-insensitive. MCP tools: `mcp__github` allows every tool from that server, `mcp__github__create_issue` just one. Omit for all tools, including every MCP tool. |
| `model` | `local`, `remote`, `inherit`, or a model alias (`small`, `medium`, `large`, or any key under `models` in config) | `local`/`remote` pin a tier; an alias pins a model; `inherit` or omitted defers to routing |
| `route` | `auto`, `local`, `remote` | Same effect as `model: local`/`remote` |
| `runtime` | name under `runtimes` | Run on an external agent runtime such as Claude Code (see below) |
| `isolation` | `worktree` | Always run this agent in its own git worktree (see below) |
| `budgetUsd` | dollars | Remote spend allowed per invocation, counting the subagent's own subagents. Once spent, its remote calls continue on the local model (`rule: agent-budget`); with no local model it stops and the parent gets the reason as the task result. Defaults to `subagents.budgetUsd` |

The body is the system prompt. Switchback appends an environment section and the project's `AGENTS.md` to it.

### Creating one

`switchback agents new` interviews you for the name, a description (what the agent does and when the parent should use it), tools, where it runs, an optional budget, and worktree isolation. It can draft the system prompt with your model (the local one when available), then validates the file and writes it to `.switchback/agents/` or `~/.config/switchback/agents/`. New and edited agent files are picked up without restarting: `/agents`, `switchback agents`, and new sessions see them right away. Every question has a flag for scripted use:

```sh
switchback agents new --yes --name reviewer --tools read,grep,glob --model local \
  --description "Reviews a diff for correctness bugs. Use after making changes." \
  --prompt "You review diffs for bugs; report each with file:line."
```

### Lookup order

Later locations override earlier ones by name:

1. Built-ins
2. `~/.config/switchback/agents/*.md` (user)
3. `.switchback/agents/*.md` (project)

Files that fail to parse are skipped and reported by `switchback doctor` and at startup. They never prevent the engine from starting.

### Model aliases

`model: large|medium|small` means the large, medium, and small model of the remote provider you chose in `switchback init`, whether that's Anthropic, OpenAI, DeepSeek, or another. So an agent with `model: small` runs on `gpt-6-luna`, `deepseek-flash`, or Claude Haiku, depending on your setup. See [providers.md](providers.md#model-aliases-are-tiers) for the mapping, and point any alias at any model in config. An alias that isn't configured is ignored and normal routing applies.

## The `task` tool

```json
{ "agent": "explore", "description": "find auth middleware", "prompt": "Find where HTTP auth is enforced..." }
```

- The subagent starts with an empty transcript. `prompt` has to be self-contained, because the subagent can't see the parent conversation.
- Only the subagent's final text returns to the parent. Its tool calls are visible to the user (clients show them nested under the task) but not to the parent model.
- A subagent that fails or is cancelled returns an error result, which the parent can handle.
- Cancelling the parent turn cancels its subagents.

### External runtimes

An agent can run on a complete external agent instead of the Switchback loop ([ADR 0009](adr/0009-external-agent-runtimes.md)). The first supported runtime is **Claude Code, through the Claude Agent SDK**:

```jsonc
// config
"runtimes": { "claude": { "type": "claude-agent-sdk", "model": "claude-sonnet-5", "maxTurns": 30 } }
```

```markdown
---
name: claude-coder
description: Hands a self-contained coding task to Claude Code. Use for larger changes.
runtime: claude
budgetUsd: 2
isolation: worktree
---
```

- The parent delegates with the ordinary `task` tool. The subagent row shows Claude Code's text and tool calls as they happen.
- Every tool Claude Code wants to use goes through the Switchback permission policy (`Read`/`Grep`/`Glob` as `read`, `Edit`/`Write` as `edit`, MCP tools as `mcp`, everything else as `bash`), including org-enforced denials.
- It's remote spend: it doesn't start with `routing.allowRemote: false`, when an organization disables remote models, or when the budget is spent. The agent's `budgetUsd` becomes Claude Code's own spending limit. Its cost, as reported by the SDK, is recorded per model under rule `runtime`, so `switchback usage --by rule` shows it.
- It uses Claude Code's credentials (`ANTHROPIC_API_KEY` or a Claude login). Claude Code itself isn't bundled with Switchback: install it so `claude` is on `PATH`, or set `runtimes.<name>.executable`.
- Only the final report returns to the parent, like any subagent. `isolation: worktree` works as usual.

### Worktree isolation

With `"isolation": "worktree"` on the task call (or `isolation: worktree` in the agent file), the subagent works in its own git worktree on a new branch, `switchback/<id>`, created from `HEAD`. Its file tools, shell, and `@` mentions operate there, so parallel editing subagents never touch each other or your working tree.

- **On success**, whatever it changed is committed to its branch, the worktree is removed, and the parent gets the branch name, a `--stat` summary, and the diff. The parent (or you) decides whether to merge, e.g. `git merge switchback/<id>`. A subagent that changed nothing leaves no branch behind.
- **On failure**, the worktree is kept for inspection and its path is in the report.
- It needs a git repository with at least one commit. Uncommitted changes in your working tree aren't in the worktree, since it starts from `HEAD`.
- Worktrees live in the Switchback data directory (`~/.local/share/switchback/worktrees/`), outside your repository. Commits use your git identity, or `Switchback <switchback@localhost>` when none is set.

### Background tasks

With `"background": true` the call returns at once with the task's ID and the parent keeps working. When the subagent finishes, its report is appended to the parent's transcript as a new user message (marked `backgroundTask`, shown as a note in both clients), so history stays append-only:

- If the parent is in the middle of a turn, the report is picked up at its next step.
- If an interactive session is idle, the report starts a follow-up turn so the agent can act on it. You can keep chatting while background tasks run.
- Headless `switchback run` and subagents wait for their own background tasks before they finish, so nothing is left running unattended.
- Cancelling the session (esc in the TUI, Cancel in VS Code) cancels its background tasks and drops their reports.

## Limits

| Config | Default | Effect |
|---|---|---|
| `subagents.maxConcurrent` | 4 | Concurrent subagents per depth level. Extra calls queue. |
| `subagents.maxDepth` | 2 | Agents at this depth don't get the `task` tool. |
| `subagents.model` | none | Model for subagents whose agent doesn't pin a model or tier, for example a cheap local one for every delegated search. Any alias, local or remote. |
| `maxStepsPerTurn` | 50 | Applies to each subagent turn too. |
| `subagents.budgetUsd` | none | Remote spend per invocation for agents without their own `budgetUsd`. |

## Patterns

- **Search locally, decide remotely.** Keep the primary agent on `auto`. Have it delegate "find X" to `explore` (local) and make decisions with the summary.
- **Fan out reviews.** Define `security-reviewer`, `perf-reviewer`, and `test-reviewer` with `model: sonnet` and ask the primary agent to run them in parallel.
- **Cheap bulk edits.** An agent with `model: local` and `tools: read, edit` can apply mechanical changes across many files at zero cost. The primary agent verifies afterwards.
