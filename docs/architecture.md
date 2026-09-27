# Architecture

## The shape of the system

```
 ┌──────────────┐   ┌──────────────────────┐   ┌───────────────┐
 │  TUI (Ink)   │   │  VS Code extension   │   │ harness run / │
 │  apps/cli    │   │  host  +  webview    │   │ 3rd-party     │
 └──────┬───────┘   └──────────┬───────────┘   └───────┬───────┘
        │ in-process pair      │ stdio (child process) │
        └──────────────┬───────┴───────────────────────┘
                       │  JSON-RPC 2.0, NDJSON  (@harness/protocol)
               ┌───────▼────────────────────────────────────────┐
               │ Engine (@harness/engine)                       │
               │  sessions · agent loop · tools · permissions   │
               │  subagents · config · usage ledger · store     │
               │        │                     │                 │
               │  ┌─────▼──────┐     ┌────────▼─────────┐       │
               │  │ Router     │     │ Providers        │       │
               │  │ (pure)     │     │ local │ remote   │       │
               │  └────────────┘     └───┬───┴────┬─────┘       │
               └─────────────────────────┼────────┼─────────────┘
                                         │        │
                          Ollama / llama.cpp /    OpenAI / Anthropic / DeepSeek /
                          LM Studio / vLLM        Bedrock / Vertex / any OpenAI-compatible
```

The engine is the product. Clients are views. That split is what lets the terminal and VS Code experiences stay consistent: there's exactly one implementation of routing, tools, permissions, and agents, and both clients fold the same event stream through the same reducer ([ADR 0001](adr/0001-engine-client-split.md)).

## Packages

| Package | Responsibility |
|---|---|
| `@harness/protocol` | The contract. Transcript types (`Message`, `Part`), JSON-RPC framing, every method and event, transports. No dependencies on other workspace packages. |
| `@harness/providers` | Talks to models. Each adapter translates the neutral transcript to a wire format and streams back `ChatEvent`s. Also holds the model catalog, pricing, and local-server detection. No provider is privileged ([ADR 0006](adr/0006-provider-neutrality.md)). |
| `@harness/router` | Decides local vs. remote for each model call. Pure functions over a snapshot. |
| `@harness/engine` | Runs agents. Owns all state and all side effects. Exposes itself via `serve(engine, transport)`. |
| `@harness/client` | What clients import: `HarnessClient`, `spawnEngine`, and the view-model reducer. |

## Lifecycle of a turn

1. The client calls `session.prompt { sessionId, text, route }`. The engine returns a `turnId` immediately and emits events from then on.
2. The engine appends the user message to the transcript (in memory and in the session's JSONL file).
3. **Step loop**, up to `maxStepsPerTurn`:
   1. Refresh provider health (cached: 30 s when healthy, 5 s when failing).
   2. Ask the router for a decision, passing the agent's pin, the user's preference, the estimated input tokens, the session's quality signals, and current spend. Emit `route.decided`. If the decision is `ask`, emit `escalation.requested` and wait. If it's `block`, emit `error` and stop.
   3. Stream from the chosen provider, relaying `text.delta` and `reasoning.delta`.
   4. On provider failure: record the failure (a quality signal for local), mark the provider unhealthy if the error is retryable, and loop. The router escalates or falls back.
   5. Record usage in the ledger and emit `usage.updated`.
   6. If the local model refused or hit `max_tokens` mid-tool-call, discard that response and re-route (up to two retries). Otherwise append the assistant message.
   7. With no tool calls, the turn is done. Otherwise validate each call, check permissions (possibly emitting `permission.requested` and waiting), execute, feed results back to the signal tracker, and append all results as one user message. Read-only calls run in parallel; any mutating call makes the batch sequential.
4. Emit `turn.completed { stopReason }`.

Escalation happens at step granularity, so one user turn can start local, escalate mid-way, and finish remote. Every message records the model and routing reason in `meta`.

## Subagents

The `task` tool creates a child session (`parentId` set) running a named agent with a fresh context, runs a full turn, and returns only the final text to the parent. Child events carry `parentSessionId` so clients can render a tree. Concurrency is limited per depth level (`subagents.maxConcurrent`), which rules out deadlock: a parent holding a slot never waits on a slot at its own depth. `subagents.maxDepth` removes the `task` tool from agents at the limit. See [subagents.md](subagents.md).

## State and persistence

| What | Where | Format |
|---|---|---|
| User config | `~/.config/harness/config.json` | JSONC |
| Project config | `.harness/config.json` | JSONC |
| Agent definitions | `~/.config/harness/agents/`, `.claude/agents/`, `.harness/agents/` | Markdown + YAML frontmatter |
| Sessions | `~/.local/share/harness/sessions/<id>.jsonl` | Header line, then one message per line, append-only. Written on the first message, so the header has the title and unused sessions leave no file. |
| Usage ledger | `~/.local/share/harness/usage.jsonl` | One entry per model call |

`HARNESS_HOME` relocates everything (tests and development). `XDG_CONFIG_HOME` and `XDG_DATA_HOME` are respected.

Append-only files make crash recovery trivial: a torn final line is ignored and everything before it is intact. More importantly, append-only history is required for provider prompt caching and for Claude's thinking-block validation ([ADR 0003](adr/0003-neutral-append-only-transcript.md)).

## Transports

| Transport | Used by | Notes |
|---|---|---|
| In-process pair (`createTransportPair`) | TUI, `harness run`, tests | Messages are JSON round-tripped, so it behaves exactly like a wire. |
| stdio (`harness serve --stdio`) | VS Code, any external client | NDJSON on stdin/stdout; logs on stderr. |
| Socket / WebSocket (planned) | Shared daemon: attach TUI and VS Code to the same live session | Same framing. Tracked in the roadmap. |

## Security boundaries

- Tools can only touch paths inside the workspace root. Symlink escapes are resolved before the check.
- Mutating tools (`write`, `edit`, `bash`) go through the permission policy. The default is `ask`.
- Headless runs never escalate on the `ask` policy and deny `ask` permissions unless `--yes` is passed.
- Secrets come from the environment (`{env:NAME}` in config) or the provider SDK's credential chain, never from files in the repo.

See [permissions.md](permissions.md) and [SECURITY.md](../SECURITY.md).
