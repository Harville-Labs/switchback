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
| [0014](0014-open-core-licensing.md) | Apache-2.0 for Switchback, proprietary hosted sites | Accepted |
| [0015](0015-role-based-routing.md) | Roles (start, escalate, review, subagents) filled by any model; local/remote is a model property | Accepted |
| [0016](0016-open-conventions.md) | Open conventions (AGENTS.md, `.switchback/`), never another agent's files | Accepted |
| [0017](0017-live-instructions.md) | AGENTS.md changes reach running sessions as appended reminders | Accepted |
| [0018](0018-outside-the-workspace.md) | Files outside the workspace: reads as usual, edits ask; some places are always off limits | Accepted |
