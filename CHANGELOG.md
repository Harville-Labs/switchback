# Changelog

All notable changes to Harness. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow SemVer.

## [Unreleased]

### Added
- Subagent drill-down: the shared view keeps a nested view per subagent. VS Code rows expand to show a subagent's routes, tool calls, nested subagents, and report; the TUI shows running subagents' activity inline and adds `/subagents` and `/subagent <n>` (#18)
- MCP client support with the official SDK: stdio, streamable HTTP, and SSE servers under `mcpServers` (Claude Code's format; a project's `.mcp.json` is read too). Tools appear as `mcp__<server>__<tool>`, agents can list them, and a new `permissions.mcp` category (default `ask`) can be overridden per server. Project-defined servers start only after `harness mcp trust`. `harness mcp`, `/mcp`, `mcp.list`, and a doctor section show server state; orgs can set `allowUserMcpServers: false` (#21)
- Per-agent budgets: `budgetUsd` in agent frontmatter (or `subagents.budgetUsd`) caps remote spend per subagent invocation, including nested subagents. Over budget, the subagent continues locally (`agent-budget`), or stops and tells its parent why when there's no local model (#23)
- Background subagents: `task` with `background: true` returns at once; the report is appended to the parent later (next step if it's busy, a follow-up turn if an interactive session is idle). Headless runs and subagents wait for their background work; cancelling a session cancels it (#20)
- Worktree isolation: `isolation: worktree` (task call or agent file) runs a subagent in its own git worktree and branch. On success its changes are committed to `harness/<id>` and the parent gets the branch and diff; on failure the worktree is kept (#19)

## [0.4.0] - 2026-09-27

### Added
- Several providers at once: `routing.local` and `routing.remote` take ordered lists of model aliases from any mix of providers, including several local servers. The router uses the first reachable model whose window fits, so a big prompt moves to a bigger local model (`context-fit`) and a down server hands over to the next (`fallback`) before anything goes remote. `harness init` adds more local models and fallback remote providers; `--local-model` and `--remote` repeat
- Append-only context compaction ([ADR 0008](docs/adr/0008-append-only-compaction.md)): long sessions are summarized into a marker, by a local model when possible, so they keep fitting the local window; the full transcript is kept. `session.compact`, `/compact`, and the VS Code "Compact Conversation" command compact on request; `context.compacted` reports it (#16)
- Refusal handling for every provider: a remote refusal is retried on the next model in `routing.remote` (`refusal-fallback`), and the refused output is discarded. The first-party Anthropic API also gets server-side `fallbacks: "default"`, with the answering model billed and reported (#14)
- Optional pre-routing classifier (`routing.classifier`): a small local model rates each new prompt, and hard ones start remote under the `classifier` rule, following `escalation.policy`. Off by default, local-only, skipped on timeout. On the labeled set, qwen3:1.7b scored precision 1.00 / recall 0.90 (#12)
- Escalation prompts show an estimated cost (`≈ $0.04`) in the TUI and VS Code; `escalation.requested` carries `estimatedCostUsd` (#13)
- Routing analytics: the ledger records each call's routing rule and agent; `harness usage --period today|week|month --by rule|agent|model`; `/usage` shows the week with a breakdown; the remote cache hit rate is reported (#17)
- Accurate token counts: a BPE tokenizer, and near the local threshold the local server's own `/tokenize` (llama.cpp, vLLM); `route.decided` reports `inputTokens` (#11)
- Prompt-cache verification: a test guards the byte-stable request prefix, and a warning is logged once per session when a follow-up remote call misses the cache (#15)
- `effort: "none"` turns thinking off on every provider
- A declined escalation is reported as `escalation-declined`

### Changed
- OpenAI-compatible providers (OpenAI, DeepSeek, Ollama, vLLM, llama.cpp, LM Studio, hosted gateways) use the official `openai` SDK: typed errors, backoff on 429/5xx for hosted APIs, fail-fast for local servers. `OPENAI_*` environment variables are never picked up implicitly, so a key can't leak to another server
- Config files are parsed with `jsonc-parser` (trailing commas allowed, errors give line and column), and `harness init` edits existing files in place, keeping comments and formatting
- `harness init`: the openai-compatible remote's window is now `--remote-context-window`; `--context-window` pairs with each `--local-model`
- Local servers receive at most `reasoning_effort: "high"` (Ollama rejects `xhigh`/`max`)
- TUI `@` file completion uses fzf's matching algorithm

### Fixed
- `mode: local-only` no longer falls back to a remote model when the local server is down
- TUI prompt editing no longer splits emoji, flags, or combining accents
- VS Code's usage notification says "last 7 days", matching the numbers it shows

## [0.3.0] - 2026-09-27

### Added
- VS Code: platform-specific `.vsix` packages bundle the engine; Marketplace/Open VSX publishing when tokens are configured
- VS Code: Markdown rendering in chat (raw HTML escaped, http(s)/mailto links only, DOMPurify as a second layer) with Copy / Insert-at-cursor on code blocks; session history picker
- VS Code integration tests running inside a real VS Code instance in CI
- VS Code: review proposed edits in the diff editor with Accept / Reject in the editor title; protocol adds `proposed` (full new file) to `permission.requested` and `permission.resolved` / `escalation.resolved` events so every client clears answered prompts
- Prompt attachments in the protocol (`file` ranges read by the engine, labeled `text`); VS Code chips attach the selection, active file, or its problems
- Shared engine daemon (`harness serve --socket`): the TUI and VS Code attach to one engine per workspace by default and share live sessions; token-authenticated socket, version-checked, idle exit, automatic fallback to a private engine
- Mock provider can script a tool call (`mock:tool {json}`) for demos and client development

### Fixed
- VS Code: activation hung until the user dismissed the "no local model" or "could not start" notification
- `shutdown` closed the connection before its reply was written

## [0.2.0] - 2026-09-27

### Added
- Organization policy: `harness login` (device flow or token), `logout`, `whoami`. An org server pushes default models (e.g. company GPU servers), enforced settings, and restrictions (remote off, provider allowlists, org-only providers, spend caps), applied live with a `config.updated` event; daily usage aggregates are reported. Reference server included; see docs/organizations.md
- First-class OpenAI and DeepSeek providers alongside Anthropic: OpenAI uses `max_completion_tokens` and `reasoning_effort`; DeepSeek gets thinking mode and same-model `reasoning_content` replay; cached tokens are priced correctly for both
- Model catalog (IDs, tiers, context windows, list prices) shared by setup and pricing; ADR 0006 on provider neutrality
- `harness init` setup wizard: detects Ollama, LM Studio, llama.cpp, and vLLM, reads tool support and effective context size, configures Anthropic, Bedrock, or Vertex, escalation policy, and budgets; fully scriptable with flags
- `harness config path|show|schema|edit`
- First-run setup offer in the TUI; "Set Up Models" in VS Code
- Config JSON Schema with validation and autocomplete in VS Code
- Session resume: `harness --continue`, `--session <id>`, `/sessions`, `/resume`; shared `fromTranscript` view rebuild
- `models.<alias>.contextWindow` is optional for local models: the engine asks the server what it loads, and `doctor` reports the value and its source
- TUI prompt editor: multi-line (Option/Alt+Enter, Ctrl+J, or trailing `\`), per-workspace history on ↑/↓, and `@file` mentions with fuzzy completion; the engine attaches mentioned files (up to 10, 200 KB each) for every client
- TUI renders finished assistant messages as Markdown (headings, lists, tables, highlighted code), wrapped to the terminal width; streaming text stays plain
- `grep` uses ripgrep when installed (honors `.gitignore`, ~3x faster on a 20k-file tree), falling back to the JS search for patterns rg can't parse (lookaround) or when rg is absent
- Live test suite (`bun run test:live`) and nightly workflow: the same read/edit/subagent/escalation scenarios against a real local model and every hosted provider with credentials
- Release workflow: tag `v*` builds 5 platform binaries plus the `.vsix`, with checksums and changelog notes; `scripts/release.ts` keeps versions in sync
- Diff previews in edit/write permission prompts (TUI and VS Code); doomed edits fail without prompting

### Changed
- **Breaking:** no default providers or models at all. Harness doesn't pick a vendor; `harness init` asks, offering OpenAI, Anthropic, DeepSeek, Bedrock, Vertex, and any OpenAI-compatible API on equal terms
- `opus`/`sonnet`/`haiku` agent aliases mean large/medium/small on the chosen provider
- **Breaking:** no default local provider or model. Configure one with `harness init`. Without one, turns route remotely and local-only requests are refused with guidance.
- Agents pinned to `local` fall back to normal routing when no local model is configured
- Requires Bun 1.4+

### Fixed
- An "allow always" permission grant could override a `deny` setting; `deny` now always wins
- **Security:** on Windows, file tools accepted paths outside the workspace (the escape check assumed `/` separators)
- The `bash` tool now works on Windows: Git Bash when installed (never the WSL launcher), otherwise PowerShell, otherwise cmd; the system prompt names the shell
- Sessions were kept in memory only in the CLI; they now persist to the data directory
- Session titles were lost on disk (the header was written before the first prompt)

## [0.1.0] - 2026-09-26

### Added
- Engine with JSON-RPC protocol over stdio and in-process transports
- Router: user override, mode, agent pins, context overflow, stickiness, quality-signal escalation (`auto`/`ask`/`off`), budgets, and cross-tier fallback
- Providers: OpenAI-compatible (Ollama, llama.cpp, LM Studio, vLLM), Anthropic API, Amazon Bedrock, Vertex AI, and mock
- Tools: read, glob, grep, edit, write, bash, task, with workspace confinement and permission policy
- Subagents with per-agent routing, parallel execution, and depth limits; Claude Code agent file compatibility
- Usage ledger with per-tier cost, budgets, and estimated savings
- Terminal UI, headless `run`, `serve --stdio`, `doctor`, `usage`
- VS Code extension with chat view, routing control, status bar, and permission prompts
