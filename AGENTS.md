# AGENTS.md

Guide for AI coding agents (Claude Code, Harness itself, Codex, Cursor, and others) and for the humans reviewing their work. Read this before changing anything.

## What this repo is

Harness is a local-first coding agent. Most turns run on a local model; the router escalates the hard ones to a remote provider the user chooses: OpenAI, Anthropic, DeepSeek, Bedrock, Vertex, Claude Platform on AWS, Microsoft Foundry, or any OpenAI-compatible API. It ships as a terminal UI and a VS Code extension, both thin clients of one engine.

Design docs live in [docs/](docs/README.md). Start with [docs/architecture.md](docs/architecture.md).

## Commands

```sh
bun install                      # install workspace dependencies
bun run check                    # lint + typecheck + tests; run before every commit
bun test                         # all tests
bun test packages/router         # one package
bun run dev -- --mock            # TUI with scripted providers (no model needed)
bun run dev -- run --mock "hi"   # headless one-shot
bun run dev -- doctor            # show effective config and provider health
bun run format                   # apply Biome formatting
```

Set `HARNESS_HOME=$(mktemp -d)` when running the CLI during development so you never touch the real `~/.config/harness` or usage ledger.

## Layout

| Path | Owns | Must not |
|---|---|---|
| `packages/protocol` | Wire types, JSON-RPC framing, transports, the transcript model | Import any other workspace package |
| `packages/providers` | Provider interface and adapters (OpenAI-compatible, Anthropic/Bedrock/Vertex, mock), pricing | Know about routing, tools, or sessions |
| `packages/router` | Pure routing decisions and escalation signals | Do I/O. It takes snapshots and returns decisions. |
| `packages/engine` | Sessions, the agent loop, tools, permissions, subagents, config, ledger, organization policy (`src/org`), JSON-RPC server | Render anything |
| `packages/client` | Typed protocol client, child-process transport, shared view-model reducer | Import engine code |
| `apps/cli` | `harness` binary: TUI (Ink), `run`, `serve --stdio`, `doctor`, `usage` | Contain agent behavior |
| `apps/vscode` | VS Code extension (host + webview) | Contain agent behavior |

## Invariants

These hold the product together. A change that breaks one needs an ADR in `docs/adr/` first.

1. **Clients are thin.** The TUI and VS Code extension talk to the engine only through `@harness/client` and the protocol. Neither imports `@harness/engine` internals for behavior. The TUI runs the engine in-process, but still through a transport pair, not a private fast path. If a client needs something, add a protocol method or event.
2. **One view model.** Both clients render from `reduce()` in `packages/client/src/view.ts`. Fix display logic there, not in one client.
3. **The router is pure.** `Router.decide()` has no I/O, no clock, and no randomness. The engine gathers health, spend, and signals, then passes them in. Every decision carries a `rule` and a human-readable `reason` that the UI shows.
4. **Transcripts are append-only.** Never rewrite or delete earlier messages in a session. Provider prompt caches and reasoning replay (Claude thinking signatures, DeepSeek `reasoning_content`) depend on stable prefixes. Compaction appends a marker and changes only what is *sent* ([ADR 0008](docs/adr/0008-append-only-compaction.md)); build request context with `contextOf()`, never from `s.messages` directly.
5. **Reasoning is only replayed to the model that produced it.** `ReasoningPart.origin` records the provider and model. Adapters drop reasoning from other models when translating.
6. **Tool inputs are untrusted.** Validate with the tool's Zod schema, confine paths with `resolveInWorkspace`, and never run tool calls from a response that stopped on `max_tokens` or `refusal`.
7. **Stable prompt prefix.** The system prompt is frozen when a session is created, and the tool list order is fixed (`ALL_TOOLS`). Don't put timestamps or per-request data in either.
8. **stdout is for protocol only** in `serve --stdio`. Logs go to stderr or `log` events.
9. **Provider neutrality.** No vendor is a default and none gets features the others don't. Provider-specific behavior lives only in `packages/providers`. When you add something for one provider (a catalog entry, a setup option, pricing, docs), do it for all of them or say in the PR why it can't apply. See [ADR 0006](docs/adr/0006-provider-neutrality.md).
10. **Local never silently costs money.** Remote spend happens only through a routing decision the user can see, within budget, or on an explicit `remote` request.

## How to make common changes

**Add a protocol method or event.** Define it in `packages/protocol/src/methods.ts` (Zod schema for params, type for result), handle it in `packages/engine/src/server.ts`, fold any new event into `packages/client/src/view.ts`, then surface it in both clients. Add a round-trip test in `packages/engine/src/engine.test.ts`. Additive changes don't bump `PROTOCOL_VERSION`; removing or changing a field does. See [docs/protocol.md](docs/protocol.md).

**Add a provider.** Implement `Provider` in `packages/providers/src/`, add a variant to `ProviderConfig` and a case in `createProvider`, then document it in [docs/providers.md](docs/providers.md). Streaming must emit display deltas and finish with one `done` event carrying the canonical parts. Put retryable failures (connection, 429, 5xx) in a `ProviderError` with `retryable: true` so the router can fall back. Test translation and stream parsing without network access by injecting `fetch` or a client.

**Add a routing rule.** Add it to `Router.pick()` in priority order, give it a unique `rule` name, and write a test in `router.test.ts` for when it fires and when a higher-priority rule overrides it. Document it in the table in [docs/routing.md](docs/routing.md).

**Add a tool.** Create it with `defineTool` in `packages/engine/src/tools/`, choose a `permission` category, set `mutating` honestly (it controls parallel execution), and append it to `ALL_TOOLS`. Appending changes the cache prefix, so don't reorder existing tools. Add a Claude Code alias in `TOOL_ALIASES` if one exists.

**Change agent definitions.** Built-ins live in `packages/engine/src/agents.ts`. The file format must stay compatible with Claude Code's `.claude/agents/*.md`. See [docs/subagents.md](docs/subagents.md).

**Add a config key.** Add it to the Zod schema in `packages/engine/src/config.ts` with a default, run `bun run schema` (a test fails if the shipped schema is stale), document it in [docs/configuration.md](docs/configuration.md), and, if users choose it during setup, add a prompt and flag to `harness init`. Never add a default local provider or model: local setup is the user's choice.

**Change what an organization can control.** Extend `OrgPolicy` in `packages/engine/src/org/policy.ts`, apply it in `applyRestrictions` (restrictions remove things; they never add), test it in `org.test.ts` against the dev server, and document it in [docs/organizations.md](docs/organizations.md). Org-enforced settings must win over every user and project setting, including in-session grants.

## Conventions

- TypeScript strict mode, ESM, Bun 1.4+ runtime. Import workspace files with explicit `.ts` extensions.
- Biome formats and lints (single quotes, 2 spaces, 100 columns). Run `bun run format` rather than hand-formatting.
- Validate external input with Zod at the boundary (config files, protocol params, tool inputs, model output). Trust internal types after that.
- Test with `bun:test`, colocated as `*.test.ts`. Use `ScriptedProvider` for engine behavior. Tests never call real model APIs or need Ollama running.
- Comments explain *why*: a constraint, an invariant, a non-obvious tradeoff. Don't narrate what the code does.
- Errors are specific and actionable: say what was wrong and how to fix it (`models.local references unknown provider "olama"`).
- Model IDs and prices live in `packages/providers/src/catalog.ts`, the single source for every provider. Use exact provider IDs (`gpt-6-sol`, `deepseek-flash`, `claude-sonnet-5`) with no date suffixes; Bedrock IDs carry an `anthropic.` prefix. Note the date you checked prices.

## Workflow

- Work from a GitHub issue. Branch as `<type>/<issue>-<slug>`, for example `feat/12-ollama-autodetect`.
- Use Conventional Commits (`feat(router): add latency budget rule`). Reference the issue in the PR body (`Closes #12`).
- `bun run check` must pass. CI runs the same checks plus the VS Code and binary builds.
- Update docs in the same PR as behavior changes. A new config key without a line in [docs/configuration.md](docs/configuration.md) is incomplete.
- Don't hand-roll what a well-maintained library already does well (protocol SDKs, parsers, tokenizers, fuzzy matching). Use the vendor's official SDK for every provider that has one. Every runtime dependency ships to customers, so justify new ones in the PR; small, audited libraries beat home-grown code with edge-case bugs.
- Deliberately hand-rolled, with reasons: NDJSON framing and the JSON-RPC dispatcher (about 100 lines; `vscode-jsonrpc` uses LSP `Content-Length` framing and would not simplify our transports), `deepMerge` (arrays replace rather than concatenate, which org-enforced settings rely on), the abortable `Semaphore` (per-waiter abort, which `p-limit` lacks), and the TUI's multiline editor (no Ink library does multiline).

## Things not to do

- Don't call provider SDKs from anywhere except `packages/providers`.
- Don't add a "just for the TUI" or "just for VS Code" behavior path in the engine.
- Don't read `process.env` outside config loading and provider credential resolution.
- Don't log prompts, file contents, or credentials at `info` level or above.
- Don't commit secrets, `.env` files, or real usage ledgers.
