# Harness for VS Code

Local-first coding agent from Harville Labs. Most turns run on a model on your machine; Harness escalates to Claude only when the local model needs help, and shows you why.

## Requirements

- The `harness` CLI on your PATH (or set `harness.executablePath`)
- A local model server (Ollama, LM Studio, llama.cpp, or vLLM) and/or Claude credentials

Run **Harness: Set Up Models** from the command palette to configure both.

## Features

- Chat view with streaming output, tool activity, and subagent progress
- Routing control (auto / local / remote) in the chat and the status bar, with the reason for every escalation
- Inline diff previews for edits before you approve them
- Session cost, daily budget, and savings in the status bar
- Validation and autocomplete for `.harness/config.json`

The extension is a thin client of the harness engine, so it behaves exactly like the terminal UI.
