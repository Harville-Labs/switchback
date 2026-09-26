# Changelog

All notable changes to Harness. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow SemVer.

## [Unreleased]

### Added
- `harness init` setup wizard: detects Ollama, LM Studio, llama.cpp, and vLLM, reads tool support and effective context size, configures Anthropic, Bedrock, or Vertex, escalation policy, and budgets; fully scriptable with flags
- `harness config path|show|schema|edit`
- First-run setup offer in the TUI; "Set Up Models" in VS Code
- Config JSON Schema with validation and autocomplete in VS Code
- Session resume: `harness --continue`, `--session <id>`, `/sessions`, `/resume`; shared `fromTranscript` view rebuild
- Release workflow: tag `v*` builds 5 platform binaries plus the `.vsix`, with checksums and changelog notes; `scripts/release.ts` keeps versions in sync
- Diff previews in edit/write permission prompts (TUI and VS Code); doomed edits fail without prompting

### Changed
- **Breaking:** no default local provider or model. Configure one with `harness init`. Without one, turns route remotely and local-only requests are refused with guidance.
- Agents pinned to `local` fall back to normal routing when no local model is configured
- Requires Bun 1.4+

### Fixed
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
