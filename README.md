<p align="center"><img src="docs/assets/harville-labs.png" alt="Harville Labs" width="480"></p>

# Switchback

A local-first coding agent from Harville Labs. (Formerly Harness.) Most of the work runs on a model on your own machine; Switchback escalates the hard parts to the hosted model of your choice (OpenAI, Anthropic, DeepSeek, or any OpenAI-compatible API) and shows you exactly when and why it did.

- **Local by default, remote when it matters.** A transparent router sends each model call to your local model (Ollama, llama.cpp, LM Studio, vLLM) and escalates to your remote provider (OpenAI, Anthropic, DeepSeek, Gemini, Bedrock, Vertex, Claude Platform on AWS, Microsoft Foundry, or any OpenAI-compatible API) when the local model is struggling, the context won't fit, or you ask. No vendor is a default, and every provider gets the same features. Budgets cap remote spend.
- **Subagents that save money.** Delegate searches and side tasks to parallel subagents, each with its own context and routing. The built-in `explore` agent always runs locally. Agent definitions are compatible with Claude Code's `.claude/agents/*.md`, and their `opus`/`sonnet`/`haiku` model names map to your provider's large/medium/small models.
- **Draft locally, review remotely.** Optionally, a stronger model reviews every change the local model makes, and the local model fixes what it finds. A review costs a few cents; having the remote model write the change would cost many times more. See [docs/review.md](docs/review.md).
- **Private files stay private.** List paths that must never reach a remote model (`secrets/`, `*.pem`, customer data); once a session touches one, it stays on local models for good, even if you ask for remote. Credentials in anything sent remotely are redacted first. See [docs/privacy.md](docs/privacy.md).
- **Managed by your organization.** Sign in with `switchback login` and your org's server pushes approved models (including company GPU servers), spend caps, provider restrictions, or an outright remote-off switch, live. See [docs/organizations.md](docs/organizations.md).
- **Terminal and VS Code, same engine.** The TUI and the VS Code extension are thin clients of one engine and one protocol, and they render from the same view model, so they can't drift apart.

> Status: pre-release (v0.1). Progress is tracked in [GitHub issues](https://github.com/Harville-Labs/switchback/issues) and the [roadmap](docs/roadmap.md).

## Install

On macOS or Linux:

```sh
curl -fsSL https://switchback.harville.ai/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://switchback.harville.ai/install.ps1 | iex
```

The scripts ([install.sh](scripts/install.sh), [install.ps1](scripts/install.ps1)) download the binary for your machine from the latest [GitHub release](https://github.com/Harville-Labs/switchback/releases), check it against the release's `SHA256SUMS`, and put it in `~/.local/bin`, without sudo or administrator rights. `install.sh` never edits your shell profile; `install.ps1` adds the directory to your user PATH unless you pass `-NoModifyPath`. Options for `install.sh` go after `sh -s --`: `--vscode` also installs the VS Code extension, `--version 0.5.0` picks a release, and `--dir <path>` installs elsewhere. `install.ps1` takes `-VSCode`, `-Version`, and `-Dir` (run it as `& ([scriptblock]::Create((irm https://switchback.harville.ai/install.ps1))) -VSCode`) or the `SWITCHBACK_VERSION` and `SWITCHBACK_INSTALL_DIR` environment variables.

Update the CLI in place with `switchback self-update` (or `switchback self-update --check` to see whether there's a newer release). It verifies the download the same way the installers do.

For VS Code alone, install **Switchback** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=isaiah-harville.switchback) or [Open VSX](https://open-vsx.org/extension/isaiah-harville/switchback) (`code --install-extension isaiah-harville.switchback --pre-release` while Switchback is 0.x). It includes the engine. Use the terminal UI, the extension, or both: with both installed, they run the newer of the two engines and share live sessions.

## Quick start

Start a local model server (Ollama, LM Studio, llama.cpp, or vLLM) with a model that supports tool calling, then:

```sh
switchback init                   # detects your local server, picks models, writes the config
switchback doctor                 # check config, providers, and agents
switchback                        # open the TUI in the current directory
switchback run "explain src/index.ts"   # headless, one prompt
```

### From source

Requires [Bun](https://bun.sh) 1.4+. `bun run dev --` stands in for `switchback`:

```sh
bun install
bun run dev -- --mock          # try the TUI with scripted models, no setup needed
bun run dev -- init
```

Switchback ships with no default local model. Which server and model your machine runs is your choice, and `switchback init` sets it up. Running `switchback` for the first time with no config offers to run setup.

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

`switchback init` writes `~/.config/switchback/config.json` (this machine) or `.switchback/config.json` (this project). You can also edit these files directly: `switchback config edit` opens one, `switchback config show` prints the merged result, and the VS Code extension validates and autocompletes both. A typical file:

```jsonc
{
  "providers": {
    "ollama": { "type": "openai-compatible", "baseUrl": "http://localhost:11434/v1" },
    "openai": { "type": "openai" }
  },
  "models": {
    "local": { "provider": "ollama", "model": "<your model>", "contextWindow": 32768 },
    "remote": { "provider": "openai", "model": "gpt-6-sol", "contextWindow": 1050000 }
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
  cli/        `switchback` binary: TUI, run, serve --stdio, doctor, usage
  vscode/     VS Code extension
docs/         architecture, routing, subagents, providers, protocol, ADRs
```

## Development

```sh
bun run check       # Biome lint + TypeScript + tests (what CI runs)
bun test --watch
```

To work on the VS Code extension, open this folder in VS Code and run the **Run Extension** launch configuration. It builds the extension and points it at the dev CLI.

## License

Switchback is licensed under the [Apache License 2.0](LICENSE). The exception is `apps/site`, the hosted console for company sites, which is proprietary ([apps/site/LICENSE](apps/site/LICENSE)). Using Switchback on your own is free; companies pay for a site to manage it for their team ([ADR 0014](docs/adr/0014-open-core-licensing.md)).
