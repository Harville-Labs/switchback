# Switchback for VS Code

Local-first coding agent from Harville Labs. Most turns run on a model on your machine; Switchback escalates to your chosen hosted model (OpenAI, Anthropic, DeepSeek, or any OpenAI-compatible API) only when the local model needs help, and shows you why.

## Requirements

- The `switchback` CLI on your PATH (or set `switchback.executablePath`)
- A local model server (Ollama, LM Studio, llama.cpp, or vLLM) and/or an API key for a hosted provider

Run **Switchback: Set Up Models** from the command palette to configure both.

## Features

- Chat view with streaming output, tool activity, and subagent progress
- Routing control (auto / local / remote) in the chat and the status bar, with the reason for every escalation
- Inline diff previews for edits before you approve them
- Session cost, daily budget, and savings in the status bar
- Validation and autocomplete for `.switchback/config.json`

The extension is a thin client of the switchback engine, so it behaves exactly like the terminal UI.
