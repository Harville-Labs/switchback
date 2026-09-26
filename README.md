# Harness

A local-first coding agent from Harville Labs. Most of the work runs on a model on your own machine; Harness escalates the hard parts to Claude and shows you exactly when and why it did.

- **Local by default, remote when it matters.** A transparent router sends each model call to your local model (Ollama, llama.cpp, LM Studio, vLLM) and escalates to Claude on the Anthropic API, Amazon Bedrock, or Vertex AI when the local model is struggling, the context won't fit, or you ask. Budgets cap remote spend.
- **Subagents that save money.** Delegate searches and side tasks to parallel subagents, each with its own context and routing. The built-in `explore` agent always runs locally. Agent definitions are compatible with Claude Code's `.claude/agents/*.md`.
- **Terminal and VS Code, same engine.** The TUI and the VS Code extension are thin clients of one engine and one protocol, and they render from the same view model, so they can't drift apart.

> Status: pre-release (v0.1). Progress is tracked in [GitHub issues](https://github.com/Harville-Labs/harness/issues) and the [roadmap](docs/roadmap.md).

## Quick start

Requires [Bun](https://bun.sh) 1.4+.

```sh
bun install
bun run dev -- --mock          # try the TUI with scripted models, no setup needed
```

With real models, start a local model server (Ollama, LM Studio, llama.cpp, or vLLM) with a model that supports tool calling, then:

```sh
bun run dev -- init            # detects your local server, picks models, writes the config
bun run dev -- doctor          # check config, providers, and agents
bun run dev                    # open the TUI in the current directory
bun run dev -- run "explain src/index.ts"   # headless, one prompt
```

Harness ships with no default local model. Which server and model your machine runs is your choice, and `harness init` sets it up. Running `harness` for the first time with no config offers to run setup.

In the TUI, `/local`, `/remote`, and `/auto` control routing, `/agent explore` switches agents, `/usage` shows spend and savings, and `esc` cancels.

## How routing works

Every model call goes through the router, which picks the first matching rule:

1. Your explicit choice for this turn (`/remote`, `--route local`)
2. Global mode (`local-only`, `remote-only`)
3. The agent's pin (`model: haiku`, `route: local`)
4. Context overflow: the prompt won't fit the local model's window
5. Stickiness: stay remote for a couple of turns after escalating
6. Quality signals from the local model: repeated tool errors, malformed tool calls, loops, refusals, or failures. Escalates automatically, asks first, or does neither, per `routing.escalation.policy`.
7. Default: local

Budget and availability guards then apply. Over budget means staying local; a provider that's down means falling back to the other tier. Each decision appears in the UI with its reason. Details are in [docs/routing.md](docs/routing.md).

## Configuration

`harness init` writes `~/.config/harness/config.json` (this machine) or `.harness/config.json` (this project). You can also edit these files directly: `harness config edit` opens one, `harness config show` prints the merged result, and the VS Code extension validates and autocompletes both. A typical file:

```jsonc
{
  "providers": {
    "ollama": { "type": "openai-compatible", "baseUrl": "http://localhost:11434/v1" }
  },
  "models": {
    "local": { "provider": "ollama", "model": "<your model>", "contextWindow": 32768 },
    "remote": { "provider": "anthropic", "model": "claude-opus-5" }
  },
  "routing": {
    "escalation": { "policy": "ask" },
    "budget": { "dailyUsd": 5, "monthlyUsd": 50 }
  },
  "permissions": { "edit": "ask", "bash": "ask" }
}
```

See [docs/configuration.md](docs/configuration.md) for every option and [examples/](examples/) for Bedrock, Vertex, and llama.cpp setups.

## Repository layout

```
packages/
  protocol/   engine <-> client contract: JSON-RPC methods, events, transcript types
  providers/  model adapters: OpenAI-compatible (local), Anthropic/Bedrock/Vertex, mock
  router/     pure routing decisions and escalation signals
  engine/     sessions, agent loop, tools, permissions, subagents, config, usage ledger
  client/     typed protocol client and the shared view model
apps/
  cli/        `harness` binary: TUI, run, serve --stdio, doctor, usage
  vscode/     VS Code extension
docs/         architecture, routing, subagents, providers, protocol, ADRs
```

## Development

```sh
bun run check       # Biome lint + TypeScript + tests (what CI runs)
bun test --watch
```

Read [AGENTS.md](AGENTS.md) before contributing, whether you're a person or an AI agent. It covers the architectural invariants and how to add providers, tools, routing rules, and protocol methods. Process details are in [CONTRIBUTING.md](CONTRIBUTING.md).

To work on the VS Code extension, open this folder in VS Code and run the **Run Extension** launch configuration. It builds the extension and points it at the dev CLI.

## License

Proprietary. Copyright © 2026 Harville Labs, LLC. All rights reserved. See [LICENSE](LICENSE).
