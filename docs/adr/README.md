# Architecture decision records

Short records of decisions that shape the codebase. Add one when you change an invariant in [AGENTS.md](../../AGENTS.md) or make a choice a future contributor would otherwise question. Copy the format of an existing record, number it sequentially, and never edit an accepted record's decision. Supersede it with a new one instead.

| # | Decision | Status |
|---|---|---|
| [0001](0001-engine-client-split.md) | One headless engine; TUI and VS Code are thin protocol clients | Accepted |
| [0002](0002-bun-typescript-monorepo.md) | Bun + TypeScript workspace monorepo | Accepted |
| [0003](0003-neutral-append-only-transcript.md) | Provider-neutral, append-only transcript | Accepted |
| [0004](0004-pure-router.md) | Routing is a pure, explainable function | Accepted |
| [0005](0005-claude-code-agent-compat.md) | Agent definitions are compatible with Claude Code | Accepted |
