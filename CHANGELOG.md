# Changelog

All notable changes to Switchback. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow SemVer.

## [Unreleased]

## [0.6.0] - 2026-10-01

### Added
- Windows installer: `irm https://switchback.harville.ai/install.ps1 | iex` (`scripts/install.ps1`, Windows PowerShell 5.1 and PowerShell 7). Like `install.sh` it verifies the release's `SHA256SUMS`, needs no administrator rights, and takes `-Version`, `-Dir`, and `-VSCode`; it adds `~\.local\bin` to the user PATH unless `-NoModifyPath`. Site consoles show the installer for the visitor's platform (#51)
- Use the terminal UI, the VS Code extension, or both (#51). The extension runs the `switchback` CLI when it's at least as new as its bundled engine, so both use one engine. For the shared workspace engine, the newest version wins: a newer client asks an older idle daemon to step aside (`daemon.retire`, a new protocol method), and an older client attaches to a newer daemon that speaks its protocol. When they can't share, both clients now say why instead of quietly splitting sessions. **Switchback: Install Terminal Command** installs the CLI from VS Code
- The VS Code extension is on the VS Code Marketplace as `isaiah-harville.switchback` (pre-release while Switchback is 0.x; Open VSX publishing is ready once its namespace is set up), with the right engine for each platform and a universal fallback that uses `switchback` from PATH. Publishing signs in with Microsoft Entra ID through GitHub OIDC, so no Marketplace token is stored, and can be re-run for any release tag (#48)
- One-line install for macOS and Linux: `curl -fsSL https://switchback.harville.ai/install.sh | sh` (`scripts/install.sh`). It picks the build for the machine (including Apple silicon under Rosetta), verifies it against the release's `SHA256SUMS`, installs to `~/.local/bin` without sudo or profile edits, and with `--vscode` also installs the VS Code extension
- Copy and paste in the TUI: pastes arrive whole through bracketed paste (a pasted newline never submits), with terminal colors and control characters stripped; big pastes collapse to a `[Pasted text #1 · 240 lines]` chip that expands on send; dragged-in workspace files become `@` mentions. `/copy [n]` copies the last reply or its nth code block as raw text, via OSC 52 (works over SSH and tmux) and the native clipboard
- Switchback sites (ADR 0010, #39): the hosted, multi-tenant control plane Harville Labs runs at switchback.harville.ai (`apps/site`). Each company has a site with seats and members (`operator`, `admin`, `member`); operators and admins invite by email, edit versioned, validated policy, see usage by member and model, sign out devices, choose members' telemetry, and read an audit log. Switchback managers (Harville Labs staff; ADR 0012) see every site, create sites, set seats, assign each site's operators, manage the manager list, and see telemetry across sites. Members connect with `switchback login --site <id>`; signed-in clients send telemetry to their site. Built with SvelteKit (Svelte 5) and Drizzle on Postgres only (CloudNativePG in production, a Postgres container locally and in CI; ADR 0011), with authentication by Better Auth (ADR 0013): emailed sign-in links through Cloudflare SMTP, invitations that hold seats, the device authorization grant for `switchback login` with tokens bound to one site, and per-site OIDC single sign-on (#47) with DNS domain verification, sessions that work only on their own site, and an optional "require SSO"; Harville Labs staff can sign in through their own identity provider. Deployed to the homelab cluster by Flux
- Privacy: `privacy.localOnlyPaths` pins a session to local models for good once content from a matching file enters it (reads, grep hits, edits, mentions, attachments, bash commands naming the path, subagent reports). A new router guard, `privacy`, overrides every other rule, including explicit remote requests. The mark lives in the transcript, is inherited by subagents, and blocks external runtimes and remote compaction. `privacy.secrets` (default `redact`) scans every remote request with secretlint and replaces credentials with placeholders in the outbound copy only (`block` keeps the turn local instead). A `secrets.redacted` event and `🔒` markers in both clients show what happened (#45)
- Savings receipt: `/receipt` (TUI), **Show Session Receipt** (VS Code), and the last line of `switchback run` show what a session and its subagents cost against running it all on the reference remote model. `usage.get` takes a `sessionId` and reports `referenceModel`; `usage.updated` and session summaries carry `savingsUsd`, shown in both status lines (part of #35)
- Draft locally, review remotely (#46): with `review.mode: auto` (or per prompt: `/review on`, **Set Remote Review of Local Edits**, `switchback run --review`), a turn in which a local model edited files ends with a review of the turn's diff by `review.model` (default: the first remote model; a bigger local model works too). A `revise` sends the findings back to the local model to fix, up to `review.maxRounds` reviews. The review is a routing decision (rule `review`), obeys local-only mode, org policy, budgets, privacy, and secret redaction, and a `review.completed` event shows the verdict and findings in both clients
- Opt-in anonymous telemetry (#35): off by default; `switchback telemetry status|on|off|preview`, and one question in `switchback init` (always saved to the user config; a project can turn it off, never on). Daily reports of counts, token totals, costs and savings, routing rules, catalog model IDs, and provider types, plus scrubbed crash reports; never prompts, code, paths, or user-chosen names (a test checks). `DO_NOT_TRACK`, `SWITCHBACK_TELEMETRY=0`, VS Code's telemetry setting, and org policy all force it off. Field-by-field in docs/telemetry.md

### Changed
- Harness is now **Switchback**. Everything was renamed with no fallbacks: the `switchback` command, `~/.config/switchback` and `.switchback/` (move an existing `~/.config/harness` there), `SWITCHBACK_*` environment variables, `@switchback/*` packages, the VS Code extension (`isaiah-harville.switchback`, settings and commands under `switchback.`), the repository (`Harville-Labs/switchback`), and sites at switchback.harville.ai. Releases before this one are named `harness-*`
- Switchback is open source under Apache-2.0, except `apps/site`, the hosted console, which stays proprietary (ADR 0014). Using Switchback on your own is free; companies pay for a site. Releases include `LICENSE`, `NOTICE`, and `THIRD-PARTY-NOTICES.txt` for every bundled package, and each `.vsix` carries its own copy
- Sites moved from `/s/<id>` to `/sites/<id>` on switchback.harville.ai, and `switchback login --site <id>` uses the new path. Older clients must sign in again with `switchback login --server https://switchback.harville.ai/sites/<id>`
- The site console uses the Harville Labs drafting style from harville.ai; the public Switchback page lives on harville.ai, and the console's `/` goes to your sites or to sign-in
- Organization sign-in follows the OAuth RFCs: `POST /v1/device/code` and one `POST /v1/token` endpoint (device code and refresh grants) taking form posts, instead of JSON at `/v1/device/token` and `/v1/token/refresh`. Switchback runs the grant with openid-client; the token response's `org` is now optional (docs/organizations.md)
- Savings are estimated conservatively: the part of a local call's prompt that the session's previous call already sent (within five minutes) is priced as a remote cache read, not at the full input price (part of #35)

### Fixed
- VS Code compared the shared engine against the extension's version, not the version of the binary it ran, so with the CLI or `switchback.executablePath` it waited 8 seconds on every start and then ran a separate engine (#51)

## [0.5.0] - 2026-09-28

### Added
- Subagent drill-down: the shared view keeps a nested view per subagent. VS Code rows expand to show a subagent's routes, tool calls, nested subagents, and report; the TUI shows running subagents' activity inline and adds `/subagents` and `/subagent <n>` (#18)
- MCP client support with the official SDK: stdio, streamable HTTP, and SSE servers under `mcpServers` (Claude Code's format; a project's `.mcp.json` is read too). Tools appear as `mcp__<server>__<tool>`, agents can list them, and a new `permissions.mcp` category (default `ask`) can be overridden per server. Project-defined servers start only after `switchback mcp trust`. `switchback mcp`, `/mcp`, `mcp.list`, and a doctor section show server state; orgs can set `allowUserMcpServers: false` (#21)
- Per-agent budgets: `budgetUsd` in agent frontmatter (or `subagents.budgetUsd`) caps remote spend per subagent invocation, including nested subagents. Over budget, the subagent continues locally (`agent-budget`), or stops and tells its parent why when there's no local model (#23)
- Background subagents: `task` with `background: true` returns at once; the report is appended to the parent later (next step if it's busy, a follow-up turn if an interactive session is idle). Headless runs and subagents wait for their background work; cancelling a session cancels it (#20)
- Worktree isolation: `isolation: worktree` (task call or agent file) runs a subagent in its own git worktree and branch. On success its changes are committed to `switchback/<id>` and the parent gets the branch and diff; on failure the worktree is kept (#19)
- Providers: Claude Platform on AWS (`anthropic-aws`, with server-side refusal fallbacks) and Microsoft Foundry (`foundry`), on the shared Claude adapter; both in `switchback init` and `doctor` (part of #24)
- Google Gemini (`type: gemini`, Gemini API or Vertex AI) via `@google/genai`: thought signatures replayed verbatim to the same model, thinking levels and budgets from `effort`, safety stops as refusals, and Gemini 3.1 Pro / 3.8 Flash / 2.5 Flash in the catalog and `switchback init` (#24)
- `switchback agents new`: an interview (with flags for scripted use) that writes a validated agent file, optionally with a system prompt drafted by your model; `switchback agents` lists agents, and new or edited agent files are picked up without a restart (#25)
- External agent runtimes as subagents (ADR 0009), starting with Claude Code through the Claude Agent SDK: `runtime: <name>` in an agent file. Its tool calls go through the Switchback permission policy, its progress appears in the subagent tree, it obeys routing and budgets like any remote call, and its reported cost is recorded under rule `runtime` (#22)
- OpenAI Responses API (`api: "responses"` on an `openai` provider): reasoning is kept between tool calls as encrypted items (`store: false`) and replayed only to the model that produced it (part of #24)

## [0.4.0] - 2026-09-27

### Added
- Several providers at once: `routing.local` and `routing.remote` take ordered lists of model aliases from any mix of providers, including several local servers. The router uses the first reachable model whose window fits, so a big prompt moves to a bigger local model (`context-fit`) and a down server hands over to the next (`fallback`) before anything goes remote. `switchback init` adds more local models and fallback remote providers; `--local-model` and `--remote` repeat
- Append-only context compaction ([ADR 0008](docs/adr/0008-append-only-compaction.md)): long sessions are summarized into a marker, by a local model when possible, so they keep fitting the local window; the full transcript is kept. `session.compact`, `/compact`, and the VS Code "Compact Conversation" command compact on request; `context.compacted` reports it (#16)
- Refusal handling for every provider: a remote refusal is retried on the next model in `routing.remote` (`refusal-fallback`), and the refused output is discarded. The first-party Anthropic API also gets server-side `fallbacks: "default"`, with the answering model billed and reported (#14)
- Optional pre-routing classifier (`routing.classifier`): a small local model rates each new prompt, and hard ones start remote under the `classifier` rule, following `escalation.policy`. Off by default, local-only, skipped on timeout. On the labeled set, qwen3:1.7b scored precision 1.00 / recall 0.90 (#12)
- Escalation prompts show an estimated cost (`≈ $0.04`) in the TUI and VS Code; `escalation.requested` carries `estimatedCostUsd` (#13)
- Routing analytics: the ledger records each call's routing rule and agent; `switchback usage --period today|week|month --by rule|agent|model`; `/usage` shows the week with a breakdown; the remote cache hit rate is reported (#17)
- Accurate token counts: a BPE tokenizer, and near the local threshold the local server's own `/tokenize` (llama.cpp, vLLM); `route.decided` reports `inputTokens` (#11)
- Prompt-cache verification: a test guards the byte-stable request prefix, and a warning is logged once per session when a follow-up remote call misses the cache (#15)
- `effort: "none"` turns thinking off on every provider
- A declined escalation is reported as `escalation-declined`

### Changed
- OpenAI-compatible providers (OpenAI, DeepSeek, Ollama, vLLM, llama.cpp, LM Studio, hosted gateways) use the official `openai` SDK: typed errors, backoff on 429/5xx for hosted APIs, fail-fast for local servers. `OPENAI_*` environment variables are never picked up implicitly, so a key can't leak to another server
- Config files are parsed with `jsonc-parser` (trailing commas allowed, errors give line and column), and `switchback init` edits existing files in place, keeping comments and formatting
- `switchback init`: the openai-compatible remote's window is now `--remote-context-window`; `--context-window` pairs with each `--local-model`
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
- Shared engine daemon (`switchback serve --socket`): the TUI and VS Code attach to one engine per workspace by default and share live sessions; token-authenticated socket, version-checked, idle exit, automatic fallback to a private engine
- Mock provider can script a tool call (`mock:tool {json}`) for demos and client development

### Fixed
- VS Code: activation hung until the user dismissed the "no local model" or "could not start" notification
- `shutdown` closed the connection before its reply was written

## [0.2.0] - 2026-09-27

### Added
- Organization policy: `switchback login` (device flow or token), `logout`, `whoami`. An org server pushes default models (e.g. company GPU servers), enforced settings, and restrictions (remote off, provider allowlists, org-only providers, spend caps), applied live with a `config.updated` event; daily usage aggregates are reported. Reference server included; see docs/organizations.md
- First-class OpenAI and DeepSeek providers alongside Anthropic: OpenAI uses `max_completion_tokens` and `reasoning_effort`; DeepSeek gets thinking mode and same-model `reasoning_content` replay; cached tokens are priced correctly for both
- Model catalog (IDs, tiers, context windows, list prices) shared by setup and pricing; ADR 0006 on provider neutrality
- `switchback init` setup wizard: detects Ollama, LM Studio, llama.cpp, and vLLM, reads tool support and effective context size, configures Anthropic, Bedrock, or Vertex, escalation policy, and budgets; fully scriptable with flags
- `switchback config path|show|schema|edit`
- First-run setup offer in the TUI; "Set Up Models" in VS Code
- Config JSON Schema with validation and autocomplete in VS Code
- Session resume: `switchback --continue`, `--session <id>`, `/sessions`, `/resume`; shared `fromTranscript` view rebuild
- `models.<alias>.contextWindow` is optional for local models: the engine asks the server what it loads, and `doctor` reports the value and its source
- TUI prompt editor: multi-line (Option/Alt+Enter, Ctrl+J, or trailing `\`), per-workspace history on ↑/↓, and `@file` mentions with fuzzy completion; the engine attaches mentioned files (up to 10, 200 KB each) for every client
- TUI renders finished assistant messages as Markdown (headings, lists, tables, highlighted code), wrapped to the terminal width; streaming text stays plain
- `grep` uses ripgrep when installed (honors `.gitignore`, ~3x faster on a 20k-file tree), falling back to the JS search for patterns rg can't parse (lookaround) or when rg is absent
- Live test suite (`bun run test:live`) and nightly workflow: the same read/edit/subagent/escalation scenarios against a real local model and every hosted provider with credentials
- Release workflow: tag `v*` builds 5 platform binaries plus the `.vsix`, with checksums and changelog notes; `scripts/release.ts` keeps versions in sync
- Diff previews in edit/write permission prompts (TUI and VS Code); doomed edits fail without prompting

### Changed
- **Breaking:** no default providers or models at all. Switchback doesn't pick a vendor; `switchback init` asks, offering OpenAI, Anthropic, DeepSeek, Bedrock, Vertex, and any OpenAI-compatible API on equal terms
- `opus`/`sonnet`/`haiku` agent aliases mean large/medium/small on the chosen provider
- **Breaking:** no default local provider or model. Configure one with `switchback init`. Without one, turns route remotely and local-only requests are refused with guidance.
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
