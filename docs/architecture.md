# Architecture

## The shape of the system

```
 ┌──────────────┐   ┌──────────────────────┐   ┌───────────────┐
 │  TUI (Ink)   │   │  VS Code extension   │   │ switchback run / │
 │  apps/cli    │   │  host  +  webview    │   │ 3rd-party     │
 └──────┬───────┘   └──────────┬───────────┘   └───────┬───────┘
        │ in-process pair      │ stdio (child process) │
        └──────────────┬───────┴───────────────────────┘
                       │  JSON-RPC 2.0, NDJSON  (@switchback/protocol)
               ┌───────▼────────────────────────────────────────┐
               │ Engine (@switchback/engine)                       │
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
| `@switchback/protocol` | The contract. Transcript types (`Message`, `Part`), JSON-RPC framing, every method and event, transports. No dependencies on other workspace packages. |
| `@switchback/providers` | Talks to models. Each adapter translates the neutral transcript to a wire format and streams back `ChatEvent`s. Also holds the model catalog, pricing, and local-server detection. No provider is privileged ([ADR 0006](adr/0006-provider-neutrality.md)). |
| `@switchback/router` | Decides local vs. remote for each model call. Pure functions over a snapshot. |
| `@switchback/engine` | Runs agents. Owns all state and all side effects. Exposes itself via `serve(engine, transport)`. |
| `@switchback/client` | What clients import: `SwitchbackClient`, `spawnEngine`, and the view-model reducer. |

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
| User config | `~/.config/switchback/config.json` | JSONC |
| Project config | `.switchback/config.json` | JSONC |
| Agent definitions | `~/.config/switchback/agents/`, `.claude/agents/`, `.switchback/agents/` | Markdown + YAML frontmatter |
| Sessions | `~/.local/share/switchback/sessions/<id>.jsonl` | Header line, then one message per line, append-only. Written on the first message, so the header has the title and unused sessions leave no file. |
| Usage ledger | `~/.local/share/switchback/usage.jsonl` | One entry per model call |
| Organization sign-in | `~/.config/switchback/auth.json` | Credentials, mode 0600 |
| Organization policy cache | `~/.local/share/switchback/org-policy.json` | Last policy received, mode 0600 ([organizations.md](organizations.md)) |

`SWITCHBACK_HOME` relocates everything (tests and development). `XDG_CONFIG_HOME` and `XDG_DATA_HOME` are respected.

Append-only files make crash recovery trivial: a torn final line is ignored and everything before it is intact. More importantly, append-only history is required for provider prompt caching and for Claude's thinking-block validation ([ADR 0003](adr/0003-neutral-append-only-transcript.md)).

## Transports

| Transport | Used by | Notes |
|---|---|---|
| In-process pair (`createTransportPair`) | TUI, `switchback run`, tests | Messages are JSON round-tripped, so it behaves exactly like a wire. |
| stdio (`switchback serve --stdio`) | VS Code, any external client | NDJSON on stdin/stdout; logs on stderr. |
| Unix socket / named pipe (`switchback serve --socket`) | The shared workspace daemon: TUI and VS Code attach to it by default | Same framing; token-authenticated; see below. |

## The shared daemon

By default the TUI and VS Code don't each run an engine. They attach to one daemon per workspace, so a session started in the terminal can be watched, joined, or approved from VS Code and vice versa.

- The first client runs `switchback serve --socket` in the background. It records the socket path, a random token, its version and protocol version, and its pid in `<data>/daemons/<workspace-hash>.json` (mode 0600, directory 0700).
- Clients connect and present the token in `initialize`.
- **The newest version wins**, because the extension updates from the marketplace while the CLI updates on its own. A client uses a daemon of its own version, or a newer one that speaks the same protocol version. If the daemon is older, the client asks it to step aside with `daemon.retire` and starts its own. The daemon agrees only when the asking client is its only connection and no turn is running. Otherwise, or when the daemon is newer and speaks another protocol version, the client runs a private engine and shows why, so sessions are never split silently. A client matches the version of the binary it runs, which for VS Code can be the CLI rather than the extension (see [clients/vscode.md](clients/vscode.md#which-engine-runs)).
- Clients leaving, including calling `shutdown`, don't affect others. The daemon exits after `SWITCHBACK_DAEMON_IDLE_MS` (default 10 minutes) with no clients and no running turns.
- If anything fails, the client falls back to a private engine (in-process for the TUI, `serve --stdio` for VS Code). Opt out with `switchback --no-daemon` / `SWITCHBACK_NO_DAEMON=1` or the `switchback.sharedEngine` setting. Mock engines are never shared.
- `session.list` marks running sessions, and opening one mid-turn continues with its live events.

## Security boundaries

- Tools can only touch paths inside the workspace root. Symlink escapes are resolved before the check.
- Mutating tools (`write`, `edit`, `bash`) go through the permission policy. The default is `ask`.
- Headless runs never escalate on the `ask` policy and deny `ask` permissions unless `--yes` is passed.
- Secrets come from the environment (`{env:NAME}` in config) or the provider SDK's credential chain, never from files in the repo.

See [permissions.md](permissions.md) and [SECURITY.md](../SECURITY.md).
