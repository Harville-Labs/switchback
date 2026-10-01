# Roadmap

Each milestone below is a GitHub milestone. Individual work items are [issues](https://github.com/Harville-Labs/harness/issues) labeled by area and priority. This page covers direction; the issues are the source of truth for status. The pinned [roadmap issue #38](https://github.com/Harville-Labs/harness/issues/38) links them all.

## v0.1 Foundation (done)

Engine/client split, protocol, router with escalation signals and budgets, OpenAI-compatible and Claude (Anthropic/Bedrock/Vertex) providers, tools with permissions, subagents with per-agent routing, Claude Code agent compatibility, usage ledger with savings, Ink TUI, VS Code extension, docs.

## v0.2 Local experience (released)

Make the local path excellent, since it's where users spend most of their time.

- ~~`harness init`: detect local servers, choose models, write config~~ (done)
- Offer `ollama pull` for a recommended tool-capable model when none is installed
- Session list and resume in the TUI and VS Code
- Multi-line input, input history, `@file` mentions with completion
- Markdown and code rendering in the TUI
- Diff previews for `edit`/`write` in permission prompts
- Accurate local context window detection from the server
- Single-binary releases for macOS, Linux, and Windows

## v0.3 VS Code (released)

- Platform-specific `.vsix` with the engine bundled; Marketplace/Open VSX publishing when tokens are configured
- Markdown chat with Copy / Insert on code blocks; session history
- Review proposed edits in the diff editor with Accept / Reject
- Editor context attachments (selection, active file, problems)
- Shared engine daemon: the TUI and VS Code attach to the same live sessions
- Integration tests inside real VS Code, including the bundled engine

## v0.4 Routing intelligence (released)

Escalate less often and more precisely.

- Several providers at once: ordered model chains per tier, with `context-fit` and in-tier `fallback`
- Real token counting (a BPE tokenizer, plus the local server's `/tokenize` near the threshold)
- Optional pre-routing difficulty classifier on a small local model
- Cost preview on escalation prompts ("≈ $0.04")
- Refusal handling: a fallback chain for every provider, plus Anthropic's server-side fallbacks
- Prompt cache verification and a documented stickiness decision
- Append-only context compaction for long sessions
- Routing analytics: `harness usage --by rule|agent|model`, cache hit rate

## v0.5 Subagents and integrations (released)

- Subagent drill-down in both clients (nested subagents included)
- Background subagents that report later
- Git worktree isolation for parallel editing subagents
- MCP client support (tools; resources are next)
- External agent runtimes as subagents, starting with Claude Code via the Claude Agent SDK (Managed Agents, OpenAI Agents SDK, and Bedrock AgentCore are next)
- Per-agent budgets
- More providers: Google Gemini, the OpenAI Responses API, Claude Platform on AWS, Microsoft Foundry
- `harness agents new` for guided agent authoring

## v1.0 Product readiness

- Open-core licensing: Apache-2.0 for Harness, paid company sites (ADR 0014)
- Opt-in telemetry and crash reporting
- Signed and notarized binaries, auto-update, Homebrew (the install script shipped)
- OS sandboxing for `bash` (macOS Seatbelt, Linux bubblewrap)
- Managed policies for teams (locked budgets, allowed providers, required `ask`)
- Team usage dashboard
- Documentation site on harville.ai
- External security review
