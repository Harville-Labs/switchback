# Architecture decision records

Short records of decisions that shape the codebase. Add one when you change an invariant in [AGENTS.md](../../AGENTS.md) or make a choice a future contributor would otherwise question. Copy the format of an existing record, number it sequentially, and never edit an accepted record's decision. Supersede it with a new one instead.

| # | Decision | Status |
|---|---|---|
| [0001](0001-engine-client-split.md) | One headless engine; TUI and VS Code are thin protocol clients | Accepted |
| [0002](0002-bun-typescript-monorepo.md) | Bun + TypeScript workspace monorepo | Accepted |
| [0003](0003-neutral-append-only-transcript.md) | Provider-neutral, append-only transcript | Accepted |
| [0004](0004-pure-router.md) | Routing is a pure, explainable function | Accepted |
| [0005](0005-claude-code-agent-compat.md) | Agent definitions are compatible with Claude Code | Superseded by 0016 |
| [0006](0006-provider-neutrality.md) | No default vendor; every provider gets equal treatment | Accepted |
| [0007](0007-organization-policy.md) | Organization policy from a config server | Accepted |
| [0008](0008-append-only-compaction.md) | Append-only context compaction | Accepted |
| [0009](0009-external-agent-runtimes.md) | External agent runtimes as subagents | Accepted |
| [0010](0010-hosted-sites.md) | Hosted, site-based control plane | Accepted (storage amended by 0011, roles by 0012, auth by 0013) |
| [0011](0011-site-data-in-postgres-only.md) | Site data lives only in external Postgres | Accepted |
| [0012](0012-switchback-managers-and-site-operators.md) | Switchback managers and site operators | Accepted (auth amended by 0013) |
| [0013](0013-site-auth-with-better-auth.md) | Site authentication with Better Auth, and single sign-on per site | Accepted |
| [0014](0014-open-core-licensing.md) | Apache-2.0 for Switchback, proprietary hosted sites | Superseded by 0020 |
| [0015](0015-role-based-routing.md) | Roles (start, escalate, review, subagents) filled by any model; local/remote is a model property | Accepted (`start` renamed `current` by 0021) |
| [0016](0016-open-conventions.md) | Open conventions (AGENTS.md, `.switchback/`), never another agent's files | Accepted |
| [0017](0017-live-instructions.md) | AGENTS.md changes reach running sessions as appended reminders | Accepted |
| [0018](0018-outside-the-workspace.md) | Files outside the workspace: reads as usual, edits ask; some places are always off limits | Accepted |
| [0019](0019-switchback-domains.md) | Switchback's own domains: switchback.sh for the site and docs, app.switchback.sh for the console | Accepted |
| [0020](0020-private-console.md) | The hosted console is private; Switchback is Apache-2.0 throughout | Accepted |
| [0021](0021-current-model-and-tabs.md) | The start role is the current model, chosen from a dropdown; tabs and a sessions dashboard in both clients | Accepted |
| [0022](0022-start-from-another-agent.md) | A first setup can start from another agent's setup (OpenCode), copied once and shown before it's written | Accepted |
| [0023](0023-search-allowed-by-default.md) | Web search runs without asking by default; fetching a page still asks | Accepted |
| [0024](0024-goals.md) | `/goal` keeps a session working across turns; the model ends it with a tool, and limits, budgets, and permission prompts still apply | Accepted |
| [0025](0025-auto-approve.md) | An auto-approve mode where a model approves calls that would ask; anything it refuses still asks | Accepted |
| [0026](0026-explore-without-asking.md) | Read-only shell commands inside the workspace run under the `read` level instead of asking | Accepted |
| [0027](0027-map-reduce-compaction.md) | Compaction prunes stale tool output, summarizes the history in parts and merges them, and appends a word-for-word record | Accepted |
| [0028](0028-agents-change-their-settings.md) | The model reads Switchback's settings and models with tools, and changes them with tools that always ask and apply at once | Accepted |
| [0029](0029-agents-and-permission-levels.md) | Shift+Tab switches the session's agent (build, plan, your own); agents only tighten permissions; the permission level is `ask`, `auto`, or `bypass`, set with `/permissions` | Accepted |
| [0030](0030-read-mcp-json.md) | A project's `.mcp.json` is read, and project MCP servers start without trust unless `requireMcpTrust` is set | Accepted |
