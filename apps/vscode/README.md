# Switchback for VS Code

A local-first coding agent from Harville Labs. Most turns run on a model on your own machine. When the local model needs help, Switchback escalates that turn to the hosted provider you choose (OpenAI, Anthropic, DeepSeek, Gemini, Bedrock, Vertex, or any OpenAI-compatible API) and tells you why.

## Get started

1. Install the extension. It includes the Switchback engine for macOS (Apple silicon and Intel), Linux (x64 and arm64), and Windows (x64), so there is nothing else to install.
2. Open the **Switchback** view in the activity bar.
3. Run **Switchback: Set Up Models** from the command palette. Point it at a local model server (Ollama, LM Studio, llama.cpp, or vLLM), add an API key for a hosted provider, or both.

On other platforms, install the `switchback` CLI and the extension uses it from your PATH (or set `switchback.executablePath`).

## Features

- **Chat** with streaming answers, tool activity, and subagents you can expand to see their own work
- **Routing you can see**: Auto, Local, or Remote buttons above the input, and the models that start, escalate, and review shown right there; click one to change it for the session or save it as your default. Every escalation shows the rule that fired and why
- **Edit review**: proposed edits open in the diff editor with Accept and Reject buttons
- **Editor context**: send the selection, the active file, or its problems with one click, or use **Ask About Selection** from the editor context menu
- **Cost and savings** in the status bar: session cost, daily budget, and what you saved compared with running everything remotely
- **Privacy controls**: pin sessions that touch sensitive files to local models, and redact secrets from remote requests
- **Config validation** and autocomplete for `.switchback/config.json`

The extension is a thin client of the same engine as the `switchback` terminal UI, so both behave the same, read the same config, and can share live sessions in a workspace.

## Settings

| Setting | Default | |
|---|---|---|
| `switchback.executablePath` | empty | Engine binary to run. Empty uses the bundled engine, then `switchback` on PATH |
| `switchback.executableArgs` | `[]` | Arguments inserted before `serve --stdio` |
| `switchback.defaultRoute` | `auto` | Routing for new prompts: `auto`, `local`, or `remote` |
| `switchback.reviewEditsInDiffEditor` | `true` | Open proposed edits in the diff editor |
| `switchback.sharedEngine` | `true` | Share one engine per workspace with the terminal UI |

Models, routing, budgets, and permissions live in Switchback's own config, not in VS Code settings. See the [configuration guide](https://github.com/Harville-Labs/switchback/blob/main/docs/configuration.md).

## Privacy and telemetry

Prompts and code go only to the models your config and routing allow. Switchback's anonymous usage telemetry is off unless you turn it on, and VS Code's `telemetry.telemetryLevel: off` keeps it off. Details: [privacy](https://github.com/Harville-Labs/switchback/blob/main/docs/privacy.md) and [telemetry](https://github.com/Harville-Labs/switchback/blob/main/docs/telemetry.md).

## Links

- [Documentation](https://github.com/Harville-Labs/switchback/tree/main/docs)
- [Report an issue](https://github.com/Harville-Labs/switchback/issues)
- [Source](https://github.com/Harville-Labs/switchback) (Apache-2.0)
