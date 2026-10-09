# Switchback documentation

## Using Switchback

These pages are published for each release at [harville.ai/switchback/docs](https://harville.ai/switchback/docs) (the list below decides which; `scripts/docs-bundle.ts` builds them, and a test checks every link between them).


- [Configuration](configuration.md): every config key, file locations, environment variables
- [Providers](providers.md): local servers (Ollama, llama.cpp, vLLM, LM Studio, SGLang, KoboldCpp, Jan, TGI), OpenAI, Azure OpenAI, Anthropic, DeepSeek, Gemini, Bedrock, Vertex, Claude Platform on AWS, Microsoft Foundry, OpenRouter, any OpenAI-compatible API, and Claude Code or Codex on your own sign-in
- [Routing and escalation](routing.md): how local vs. remote is decided, budgets, tuning
- [Built-in tools](tools.md): what the model can call, and the todo checklist
- [Agents and subagents](subagents.md): built-in agents, writing your own
- [Permissions and safety](permissions.md)
- [Privacy](privacy.md): files that never leave your machine, and secret redaction
- [Review with a stronger model](review.md): a ladder of reviewers, local or remote, checks what a model changed
- [Telemetry](telemetry.md): opt-in anonymous usage statistics, field by field
- [Custom commands and skills](commands-and-skills.md): your own `/commands`, and skills the model loads when it needs them
- [Hooks](hooks.md): your own commands on session events (Claude Code's format)
- [Organizations](organizations.md): sign-in, centrally managed models, limits, and restrictions
- [Sites](sites.md): your company's site on switchback.harville.ai: seats, members, roles, policy, devices
- [Terminal UI](clients/tui.md) · [VS Code extension](clients/vscode.md)
- [Scripts and CI](clients/headless.md): `switchback run`, its output formats, and exit codes
- [Editors on ACP](clients/acp.md): Zed, JetBrains, and other editors that speak the Agent Client Protocol

## Building Switchback

- [AGENTS.md](../AGENTS.md): start here; invariants and how to make common changes
- [Architecture](architecture.md): components, turn lifecycle, persistence
- [Engine protocol](protocol.md): methods, events, versioning
- [Architecture decision records](adr/README.md)
- [Roadmap](roadmap.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)
