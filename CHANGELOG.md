# Changelog

All notable changes to Harness. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow SemVer.

## [Unreleased]

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
