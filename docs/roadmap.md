# Roadmap

Each milestone below is a GitHub milestone. Individual work items are [issues](https://github.com/Harville-Labs/switchback/issues) labeled by area and priority. This page covers direction; the issues are the source of truth for status. The pinned [roadmap issue #38](https://github.com/Harville-Labs/switchback/issues/38) links them all.

## v0.1 Foundation (done)

Engine/client split, protocol, router with escalation signals and budgets, OpenAI-compatible and Claude (Anthropic/Bedrock/Vertex) providers, tools with permissions, subagents with per-agent routing, Claude Code agent compatibility, usage ledger with savings, Ink TUI, VS Code extension, docs.

## v0.2 Local experience (released)

Make the local path excellent, since it's where users spend most of their time.

- ~~`switchback init`: detect local servers, choose models, write config~~ (done)
- Offer `ollama pull` for a recommended tool-capable model when none is installed
- Session list and resume in the TUI and VS Code
- Multi-line input, input history, `@file` mentions with completion
- Markdown and code rendering in the TUI
- Diff previews for `edit`/`write` in permission prompts
- Accurate local context window detection from the server
- Single-binary releases for macOS, Linux, and Windows

## v0.3 VS Code (released)

- Platform-specific `.vsix` with the engine bundled
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
- Routing analytics: `switchback usage --by rule|agent|model`, cache hit rate

## v0.5 Subagents and integrations (released)

- Subagent drill-down in both clients (nested subagents included)
- Background subagents that report later
- Git worktree isolation for parallel editing subagents
- MCP client support (tools; resources are next)
- External agent runtimes as subagents, starting with Claude Code via the Claude Agent SDK (Managed Agents, OpenAI Agents SDK, and Bedrock AgentCore are next)
- Per-agent budgets
- More providers: Google Gemini, the OpenAI Responses API, Claude Platform on AWS, Microsoft Foundry
- `switchback agents new` for guided agent authoring

## v0.6 Distribution and sites (released)

- One-line installers for macOS, Linux, and Windows; the VS Code Marketplace listing
- The TUI and VS Code share one engine, newest version wins
- Switchback sites: the hosted control plane for companies, with seats, policy, usage, and SSO
- Private paths and secret redaction for remote requests
- Draft locally, review remotely; savings receipts; opt-in telemetry

## v0.7 Roles (released)

- Role-based routing: any model can start, escalate, review, or run subagents (ADR 0015)
- Escalation ladder and review ladder, changeable during a session
- `switchback init` asks for models first, then which model does what
- `switchback self-update`; Azure OpenAI, OpenRouter, and more self-hosted servers in `init`
- Slash command menu and a cleaner chat in both clients

## v1.0 Product readiness (released)

- Open-core licensing: Apache-2.0 for Switchback, paid company sites (ADR 0014)
- Permission rules and modes (default, accept edits, plan, bypass), hooks, and an OS sandbox for `bash` (macOS Seatbelt, Linux bubblewrap)
- Organization policy that members can't override, including deny rules
- Checkpoints and rewind, queued and interrupting messages, resumable sessions, background shells, a checklist
- Web fetch and search, custom commands and skills, MCP resources and prompts, image input
- Claude Code and Codex as models on your own sign-in; Managed Agents, Codex, and Bedrock AgentCore as subagent runtimes
- Escalate on demand (`/up`); tokens per second; notifications; scripts and CI with `switchback run`
- Documentation at harville.ai/switchback/docs, published for each release

## Next

Tracked as issues labeled `future`:

- Signed and notarized binaries, auto-update, Homebrew (#33)
- An external security review (#37)
- Server-side enforcement of provider access and spend for organizations (#40)
- System-managed (MDM) organization policy and sign-in (#41)
- Paid company sites: plans, self-serve billing, and seats (#31)
- Checking escalation against each user's own outcomes, in place of a fixed classifier (#42)
