# Roadmap

Each milestone below is a GitHub milestone. Individual work items are [issues](https://github.com/Harville-Labs/harness/issues) labeled by area and priority. This page covers direction; the issues are the source of truth for status. The pinned [roadmap issue #38](https://github.com/Harville-Labs/harness/issues/38) links them all.

## v0.1 Foundation (done)

Engine/client split, protocol, router with escalation signals and budgets, OpenAI-compatible and Claude (Anthropic/Bedrock/Vertex) providers, tools with permissions, subagents with per-agent routing, Claude Code agent compatibility, usage ledger with savings, Ink TUI, VS Code extension, docs.

## v0.2 Local experience

Make the local path excellent, since it's where users spend most of their time.

- `harness init`: detect Ollama, LM Studio, and llama.cpp; suggest and pull a tool-capable model; write config
- Session list and resume in the TUI and VS Code
- Multi-line input, input history, `@file` mentions with completion
- Markdown and code rendering in the TUI
- Diff previews for `edit`/`write` in permission prompts
- Accurate local context window detection from the server
- Single-binary releases for macOS, Linux, and Windows

## v0.3 Routing intelligence

Escalate less often and more precisely.

- Real token counting (Claude `count_tokens`, local tokenizer) instead of the 4-chars heuristic
- Pre-routing difficulty classifier (a small local model scores the prompt before the first call)
- Cost preview on escalation prompts ("≈ $0.04")
- Refusal handling: Claude server-side fallbacks on first-party API; router-level fallback chain elsewhere
- Prompt cache verification and cache-aware stickiness
- Append-only context compaction for long sessions
- Routing analytics: escalation reasons over time, savings by agent

## v0.4 Subagents and integrations

- Subagent tree view with drill-down in both clients
- Background subagents that report later
- Git worktree isolation for parallel editing subagents
- MCP client support (tools and resources from MCP servers)
- External agent runtimes as subagents: Claude Agent SDK, Claude Managed Agents, Amazon Bedrock AgentCore
- Per-agent budgets
- More providers: Claude Platform on AWS, Microsoft Foundry, OpenAI, Gemini

## v0.5 VS Code

- Inline diff review with accept and reject
- Editor context attachments (open files, diagnostics, selection, terminal output)
- Shared engine daemon: attach the TUI and VS Code to the same live session
- Bundle a platform-specific engine binary in the `.vsix`; publish to the Marketplace and Open VSX

## v1.0 Product readiness

- Licensing and activation
- Opt-in telemetry and crash reporting
- Signed and notarized binaries, auto-update, Homebrew and install script
- OS sandboxing for `bash` (macOS Seatbelt, Linux bubblewrap)
- Managed policies for teams (locked budgets, allowed providers, required `ask`)
- Team usage dashboard
- Documentation site on harville.ai
- External security review
