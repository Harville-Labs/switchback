# 0009: External agent runtimes as subagents

**Status:** Accepted · 2026-09-27

## Context

Some work is better done by a complete agent runtime than by the harness loop: Claude Code (through the Claude Agent SDK) with its own tools and skills, a hosted Claude Managed Agents session with a sandbox, or an existing Amazon Bedrock AgentCore agent. Customers want to delegate to these from the same parent agent, see what they do, control what they may touch, and account for what they cost.

## Decision

- An **agent runtime** runs one task and reports back: `run({ prompt, cwd, signal, canUseTool, onEvent })` returns `{ ok, text, calls }`, where `calls` lists per-model usage and cost. It lives in `packages/engine/src/runtimes/`.
- Runtimes are configured under `runtimes.<name>` and selected per agent with `runtime: <name>` in the agent file. Everything else about the agent (description, tools, budget, isolation) keeps its meaning. The parent delegates with the ordinary `task` tool and can't tell the difference.
- **Visibility.** The child session emits the usual events: `route.decided` with `rule: runtime`, `text.delta`, and `tool.started`/`tool.completed` for each tool the runtime uses. Both clients' subagent tree views show them unchanged. The child's transcript gets the task and the final report.
- **Permissions.** A runtime asks before every tool call (`canUseTool`), and the engine answers with the same policy as its own tools: runtime tool names map to `read`, `edit`, `bash`, or `mcp` (anything unrecognized counts as `bash`), including org-enforced denials and user prompts.
- **Cost.** An external runtime is remote spend. It starts only when routing allows remote (not `local-only`, not disabled by the organization, budget not spent), shows as a routing decision, passes the agent's `budgetUsd` to the runtime's own limit where one exists, and records every model's usage in the ledger with the cost the runtime reports, under rule `runtime`.
- Runtimes are loaded lazily, so an unused runtime costs nothing at startup. The Claude Agent SDK runs Claude Code's native executable, which isn't bundled; Harness uses the `claude` on `PATH` or `runtimes.<name>.executable`.

The first runtime is the Claude Agent SDK. Managed Agents and Bedrock AgentCore follow the same interface.

## Consequences

- External agents are first-class subagents: parallel, backgroundable, budgeted, isolatable in worktrees, and visible.
- An external runtime's internal steps don't enter the harness transcript, only its report, so they aren't replayed to later models. That's the same boundary as any subagent.
- Provider neutrality: runtimes are vendor products by nature. The interface is neutral, and adding another vendor's runtime is a new file under `runtimes/`, not a change to the engine.
