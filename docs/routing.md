# Routing and escalation

Harness sends every model call to one of two tiers:

- **local**: a model on the user's machine or network, reached through an OpenAI-compatible server. It costs nothing per token.
- **remote**: Claude through the Anthropic API, Amazon Bedrock, or Vertex AI. It's billed per token.

The goal is to do most of the work locally and pay only for the calls that need a stronger model. The router makes that decision for each step of the agent loop, not once per session, and tells the user why.

## Decision pipeline

`Router.decide()` in `packages/router/src/router.ts` is a pure function of its input. The first matching rule picks a target:

| # | Rule (`rule` in events) | Fires when | Target |
|---|---|---|---|
| 1 | `user-override` | The prompt was sent with `route: local` or `route: remote` | That tier |
| 2 | `mode` | `routing.mode` is `local-only` or `remote-only` | That tier |
| 3 | `agent-pin` | The agent's definition names a model alias (`model: haiku`) or a tier (`model: local`, `route: remote`) | That model or tier |
| 4 | `context-overflow` | Estimated input tokens exceed `escalation.contextHeadroom` × the local model's `contextWindow` | remote (counts as an escalation) |
| 5 | `sticky` | The session escalated within the last `escalation.stickyTurns` model calls | remote |
| 6 | `escalation` | A quality signal crossed its threshold (below) and `escalation.policy` is `auto`, or the user approved an `ask` | remote |
| 7 | `default` | Nothing else matched | local |

Two guards then run on the chosen target:

- **Budget** (`rule: budget`). If the target is remote, the user didn't explicitly ask for remote, and daily or monthly spend has reached `routing.budget`, the call stays local (`onExceeded: local`) or is refused (`onExceeded: block`).
- **Availability** (`rule: fallback`). If the target's provider failed its health check, the call moves to the other tier per `routing.fallback`. If that's also unavailable or over budget, the call is blocked with an explanation.

## Quality signals

The engine reports what happens on each step to a per-session `SignalTracker`:

| Signal | Threshold (config key) | Meaning |
|---|---|---|
| Local turn failed | any | Provider error, refusal, or `max_tokens` in the middle of a tool call |
| Loop detected | `escalation.loopThreshold` (3) | The same tool with the same arguments (key order ignored) within the last 20 calls |
| Malformed tool calls | `escalation.maxMalformedToolCalls` (2) | Unknown tool names or arguments that fail schema validation, in the current user turn |
| Consecutive tool errors | `escalation.maxConsecutiveToolErrors` (3) | Tools that ran and failed, back to back |

Signals reset after an escalation and when a new user prompt starts (except stickiness).

## Escalation policy

`routing.escalation.policy`:

- `auto` (default): escalate immediately and show the reason.
- `ask`: emit `escalation.requested`. The TUI and VS Code show "Escalate to claude-opus-5? 3 consecutive tool errors [y/n]". Declining keeps the turn local. Headless runs always decline.
- `off`: never escalate on quality signals. Context overflow and outages still route remote, because the local model can't take those calls at all.

## Budgets and savings

Every model call is written to the usage ledger with its cost. Local calls cost $0 but also record `savingsUsd`, which is what the same tokens would have cost on the configured remote model (`routing.remote`). `harness usage`, `/usage`, and the VS Code status bar report spend against budget and the running savings figure.

Prices come from `DEFAULT_PRICES` in `packages/providers/src/pricing.ts` (first-party Claude API list prices). Bedrock and Vertex bill differently, so override per model with `models.<alias>.price` when accuracy matters.

## Switching models mid-session

A session's transcript is provider-neutral and append-only. When a turn moves between models:

- **Reasoning** (thinking blocks) is replayed only to the exact provider and model that produced it. Other models don't receive it, because they would ignore it or reject it.
- **Tool call IDs** from local servers are normalized for the Messages API (`[a-zA-Z0-9_-]`) when translated.
- **Prompt caching** is per model. Switching from local to remote pays for the full prefix once. Stickiness (`stickyTurns`) exists partly so a session doesn't pay that cost on every alternate step. The system prompt and tool list are frozen per session to keep the cached prefix stable.

## Tuning

- **Local model too weak for tool use?** Lower `maxMalformedToolCalls` to 1, or give tool-heavy agents `route: remote` while keeping `explore` local.
- **Escalating too often on long sessions?** Raise the local model's `contextWindow` to match what your server actually loads (Ollama defaults to a small `num_ctx`; set it in the Modelfile). Keep `contextHeadroom` below 1 to leave room for output.
- **Want approval for every dollar?** Use `policy: ask` plus a `dailyUsd` budget.
- **Laptop on battery or offline?** `mode: local-only` for guaranteed zero spend, or `mode: remote-only` to spare the machine.

## Configuration reference

```jsonc
"routing": {
  "mode": "auto",                 // auto | local-only | remote-only
  "local": "local",               // model alias for local calls
  "remote": "remote",             // model alias for remote calls (and the savings reference)
  "escalation": {
    "policy": "auto",             // auto | ask | off
    "maxConsecutiveToolErrors": 3,
    "maxMalformedToolCalls": 2,
    "loopThreshold": 3,
    "contextHeadroom": 0.85,
    "stickyTurns": 2
  },
  "budget": { "dailyUsd": 5, "monthlyUsd": 50, "onExceeded": "local" },
  "fallback": { "onLocalUnavailable": "remote", "onRemoteUnavailable": "local" }
}
```
