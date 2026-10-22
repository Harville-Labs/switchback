# Agents and subagents

An **agent** is a system prompt, a tool allowlist, and a routing preference. The same definition can drive a whole session (the primary agent) or run as a **subagent** that the primary agent delegates to through the `task` tool.

## Why subagents matter here

Subagents are both a quality feature and a cost feature:

- **Context isolation.** A subagent reads fifty files and returns a ten-line summary. The parent's context, and the size of every later remote call, stays small.
- **Parallelism.** Several `task` calls in one response run concurrently, up to `subagents.maxConcurrent` per depth level. The rest wait for a free slot.
- **Per-agent routing.** Each subagent has its own routing. The built-in `explore` agent is pinned to `local`, so broad codebase searches never cost anything, even when the parent is running on a remote model.

## Built-in agents

| Agent | Mode | Tools | Routing | Use |
|---|---|---|---|---|
| `build` | primary | all | auto | Default primary agent for coding work |
| `explore` | subagent | read, glob, grep | **local**, effort `low` | Find files, symbols, and usages; returns a summary |
| `plan` | all | read, glob, grep | auto | Produce an implementation plan without editing |
| `review` | subagent | read, glob, grep, bash | auto | Read-only review of the whole change (uncommitted work and commits made for it), not only files it was pointed to; lists bugs and missed cases with file:line |
| `general` | subagent | all | auto | Delegated multi-step tasks |

Change any of them, or turn them off, with the config `agents` key ([below](#agents-in-config)).

## Defining agents

Agents are Markdown files with YAML frontmatter in `.switchback/agents/` (the project) or `~/.switchback/agents/` (you). Switchback doesn't read other agents' folders ([ADR 0016](adr/0016-open-conventions.md)); to reuse an agent written for another tool, copy it into one of these and adjust it.

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
| `mode` | `primary`, `subagent`, `all` | Where it can run: as a session's agent (`/agent`, `--agent`), through the `task` tool, or both. Defaults to `all` |
| `effort` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | Reasoning effort for its model calls, over the model's own `effort` (see [Reasoning effort](#reasoning-effort)) |
| `maxSteps` | number | Model calls per turn, over `maxStepsPerTurn` |
| `agents` | comma list or YAML list of names or globs | The subagents it may call with `task` (`explore, review-*`). Omit for every subagent; an empty list removes its `task` tool. No agent can call a `primary`-mode agent |
| `runtime` | name under `runtimes` | Run on an external agent runtime such as Claude Code (see below) |
| `isolation` | `worktree` | Always run this agent in its own git worktree (see below) |
| `budgetUsd` | dollars | Remote spend allowed per invocation, counting the subagent's own subagents. Once spent, its remote calls continue on the local model (`rule: agent-budget`); with no local model it stops and the parent gets the reason as the task result. Defaults to `subagents.budgetUsd` |

The body is the system prompt. Switchback appends an environment section, your `~/.switchback/AGENTS.md`, and the project's `AGENTS.md` to it ([AGENTS.md](commands-and-skills.md#agentsmd)).

### Creating one

`switchback agents new` interviews you for the name, a description (what the agent does and when the parent should use it), tools, where it runs, an optional budget, and worktree isolation. It can draft the system prompt with your model (the local one when available), then validates the file and writes it to `.switchback/agents/` or `~/.switchback/agents/`. New and edited agent files are picked up without restarting: `/agents`, `switchback agents`, and new sessions see them right away. Every question has a flag for scripted use:

```sh
switchback agents new --yes --name reviewer --tools read,grep,glob --model local \
  --description "Reviews a diff for correctness bugs. Use after making changes." \
  --prompt "You review diffs for bugs; report each with file:line."
```

### Lookup order

Later locations override earlier ones by name:

1. Built-ins
2. `~/.switchback/agents/*.md` (user)
3. `.switchback/agents/*.md` (project)
4. The `agents` key in config (user, then project)

### Agents in config

The `agents` key takes the same fields as the frontmatter, plus `prompt` for the system prompt and `disable`. An entry for an existing agent changes only the fields it sets; an entry for a new name needs a `description` and a `prompt`.

```jsonc
"agents": {
  "explore": { "effort": "medium", "model": "small" },   // tune a built-in
  "general": { "disable": true },                        // turn one off
  "build": { "agents": ["explore", "review-*"] },        // limit what it may delegate to
  "review-security": {
    "description": "Reviews a diff for security bugs. Use after changing auth or input handling.",
    "prompt": "You review diffs for security bugs; report each with file:line.",
    "mode": "subagent",
    "tools": "read, grep, glob",
    "effort": "high",
    "maxSteps": 20
  }
}
```

`/agents` and `switchback agents` show `config` as the source of an agent the config changed last.

Files that fail to parse are skipped and reported by `switchback doctor` and at startup. They never prevent the engine from starting.

### Model aliases

`model: large|medium|small` means the large, medium, and small model of the remote provider you chose in `switchback init`, whether that's Anthropic, OpenAI, DeepSeek, or another. So an agent with `model: small` runs on `gpt-6-luna`, `deepseek-flash`, or Claude Haiku, depending on your setup. See [providers.md](providers.md#model-aliases-are-tiers) for the mapping, and point any alias at any model in config. An alias that isn't configured is ignored and normal routing applies.

## The `task` tool

```json
{ "agent": "explore", "description": "find auth middleware", "prompt": "Find where HTTP auth is enforced..." }
```

The parent can also choose, for one task, `model` (any configured model alias, over the agent's own) and `effort`. Switchback refuses a `model` that isn't configured, a remote model for an agent pinned to `local`, and any `model` for an agent on an external runtime, and the parent gets the reason as the task result. The subagent row shows the model and effort it ran with.

- The subagent starts with an empty transcript. `prompt` has to be self-contained, because the subagent can't see the parent conversation.
- Only the subagent's final text returns to the parent. Its tool calls are visible to the user (clients show them nested under the task) but not to the parent model. A subagent's system prompt has a short "Reporting back" section in place of the Switchback guide the top-level session gets: report what you found or changed, with file paths and line numbers, what you couldn't do, and what the caller should check.
- Reports are cut to 30,000 characters. The subagents started in one step share 60,000 between them, so a fan-out of 150 adds about as much to the parent's context as two do: each is told its share in its brief (`Keep your final report under 400 characters`), and anything past it is cut.
- A subagent's model calls go through the router like the parent's, under its own agent's routing, budget, and `routing.allowRemote`. Its row shows the model each step ran on.
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

Every runtime is remote spend under the same rules (routing, organization policy, budgets, private sessions), shows its progress on the subagent row, and reports to the parent the same way. They differ in where they work and what Switchback can approve:

| `type` | Where it works | Approval | Cost in the ledger |
|---|---|---|---|
| `claude-agent-sdk` | This workspace (Claude Code) | Every tool call, as above | Reported by the SDK |
| `claude-managed-agents` | A [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) environment: a hosted sandbox, not this workspace | Tool calls the agent's permission policy marks `ask` come to Switchback's policy; set the agent's policy to `always_ask` for Switchback to decide them all | Tokens, priced from the catalog; sandbox time is billed separately |
| `codex` | This workspace ([OpenAI Codex](https://developers.openai.com/codex/sdk), through the Codex SDK) | Codex can't stop to ask, so the whole run is approved once, as a command (`bash`), and runs in the sandbox you chose: `read-only` or `workspace-write`, with `network` off by default. Because it reads files without asking, it won't run while `privacy.localOnlyPaths` is set | Tokens, priced from the catalog for `model` |
| `bedrock-agentcore` | An agent you deployed to [Amazon Bedrock AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html), in AWS | Nothing local to approve: it uses its own tools and IAM permissions | Not reported by AgentCore, so not ledgered |

```jsonc
"runtimes": {
  "hosted": { "type": "claude-managed-agents", "agent": "agent_01…", "environment": "env_01…" },
  "codex": { "type": "codex", "model": "gpt-6-sol", "sandbox": "workspace-write" },
  "aws": { "type": "bedrock-agentcore", "arn": "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-agent-AbCd" }
}
```

Credentials: Managed Agents uses `ANTHROPIC_API_KEY` (or `apiKey`); Codex uses its own sign-in (`codex login`), `OPENAI_API_KEY`, or `apiKey`, and runs `codex` from `PATH` unless `executable` is set; AgentCore uses the AWS credential chain (environment, profile, SSO, role) and the region in the ARN. AgentCore sends the task as `{"prompt": "…"}` and shows whatever the agent streams back (server-sent events or JSON).

### Worktree isolation

With `"isolation": "worktree"` on the task call (or `isolation: worktree` in the agent file), the subagent works in its own git worktree on a new branch, `switchback/<id>`, created from `HEAD`. Its file tools, shell, and `@` mentions operate there, so parallel editing subagents never touch each other or your working tree.

- **On success**, whatever it changed is committed to its branch, the worktree is removed, and the parent gets the branch name, a `--stat` summary, and the diff. A subagent that changed nothing leaves no branch behind.
- **Merging** is up to the parent and you. The parent can call `merge_worktree`, which always asks you first and shows the diff (in every mode but `bypassPermissions`; plan mode refuses it like any edit). It merges as its own merge commit into your checked-out branch, refuses while your working tree has uncommitted changes, and on a conflict aborts and names the files, leaving everything as it was. You can always merge by hand: `git merge switchback/<id>`. Rewind (`/rewind`) doesn't undo a merge; `git revert -m 1 <merge commit>` does.
- **On failure**, the worktree is kept for inspection and its path is in the report.
- It needs a git repository with at least one commit. Uncommitted changes in your working tree aren't in the worktree, since it starts from `HEAD`.
- Worktrees live in the Switchback data directory (`~/.switchback/data/worktrees/`), outside your repository, with a note of who made each branch and why. Commits use your git identity, or `Switchback <switchback@localhost>` when none is set.

#### Seeing what they did

- **While it runs**, the subagent's row shows its branch (`⎇ switchback/1a2b3c4d5e6f`); **when it's done**, how many files it changed and lines it added and removed, or where its worktree was kept.
- **`/worktrees`** (both clients) and **`switchback worktrees`** list every `switchback/*` branch in the repository, newest first: running, ready to merge (with how many commits your branch doesn't have), merged, or kept after a failure, with the task and agent that made it.
- **`/worktrees <branch>`** shows a branch's diff since it left your branch: in the TUI as text, and in VS Code in the multi-file diff editor, each file side by side. `switchback worktrees <branch>` prints it, and `--json` gives either listing as data.

### Background tasks

With `"background": true` the call returns at once with the task's ID and the parent keeps working. When the subagent finishes, its report is appended to the parent's transcript as a new user message (marked `backgroundTask`, shown as a note in both clients), so history stays append-only:

- If the parent is in the middle of a turn, the report is picked up at its next step.
- If an interactive session is idle, the report starts a follow-up turn so the agent can act on it. You can keep chatting while background tasks run.
- Headless `switchback run` and subagents wait for their own background tasks before they finish, so nothing is left running unattended.
- Cancelling the session (esc in the TUI, Cancel in VS Code) cancels its background tasks and drops their reports.

### Splitting work across subagents

Ask for it in plain words: "use 4 subagents to find every caller of `parseConfig`", "split this migration across subagents", "have a reviewer check it". There's no limit on how many; 150 works. The `task` tool's description tells the model how:

- Start as many subagents as you ask for. With no number, as few as the work needs. If the number looks wrong for the work, too many to be worth the cost or too few to split it, the model says so and you agree on one first.
- Split the work into independent pieces and start them all in one response, so they run in parallel.
- Give each a complete brief: the goal, the files it owns, and what to report.
- Never let two subagents edit the same file. Each gets its own files, or `isolation: "worktree"` and a `merge_worktree` afterwards.
- Combine the reports into one answer.

Each subagent is a full model run, so many of them cost what that many runs cost, under the usual routing and budgets. Calls beyond `subagents.maxConcurrent` show as waiting (`◷ … waiting for a free slot`) and start as earlier ones finish (`subagent.queued`, then `subagent.started`, in the [protocol](protocol.md)). Cancelling the parent cancels the running ones and the waiting ones.

To try it without a model, the mock provider fans out a prompt of the form `use 3 subagents to <goal>`: `bun run dev -- --mock`.

## Limits

| Config | Default | Effect |
|---|---|---|
| `subagents.maxConcurrent` | 16 | Concurrent subagents per depth level. Extra calls wait for a free slot. A local server that runs fewer at once queues the rest itself, so lower this only to keep a fan-out from crowding out your own work, or to stay under a remote provider's rate limit. |
| `subagents.maxDepth` | 2 | Agents at this depth don't get the `task` tool. |
| `subagents.model` | none | Model for subagents whose agent doesn't pin a model or tier, for example a cheap local one for every delegated search. Any alias, local or remote. |
| `subagents.effort` | none | Reasoning effort for subagents whose agent sets none. |
| `maxStepsPerTurn` | 50 | Applies to each subagent turn too, unless its agent sets `maxSteps`. |
| `subagents.budgetUsd` | none | Remote spend per invocation for agents without their own `budgetUsd`. |

## Reasoning effort

Each model call gets the first effort set, most specific first:

1. The `effort` on the `task` call (subagents), or the session's effort from `/effort` or `--effort` (top level)
2. The agent's `effort`
3. `subagents.effort` (subagents only)
4. The model's own `effort` in `models.<alias>`, its default

`/effort` changes only the session you're in: subagents keep their own, and nothing is written to config. Models that don't support reasoning ignore it. See [configuration.md](configuration.md#modelsalias).

## Patterns

- **Search locally, decide remotely.** Keep the primary agent on `auto`. Have it delegate "find X" to `explore` (local) and make decisions with the summary.
- **Fan out reviews.** Ask for a review and the primary agent sends the built-in `review` agent. For more angles, define `security-reviewer`, `perf-reviewer`, and `test-reviewer` with `model: large` and ask the primary agent to run them in parallel.
- **Cheap bulk edits.** An agent with `model: local` and `tools: read, edit` can apply mechanical changes across many files at zero cost. The primary agent verifies afterwards.
