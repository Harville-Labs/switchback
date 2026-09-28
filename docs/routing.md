# Routing and escalation

Harness sends every model call to one of two tiers:

- **local**: a model on the user's machine or network, reached through an OpenAI-compatible server. It costs nothing per token.
- **remote**: a hosted model you choose: OpenAI, Anthropic, DeepSeek, Google Gemini, Amazon Bedrock, Vertex AI, Claude Platform on AWS, Microsoft Foundry, or any OpenAI-compatible API. It's billed per token.

Each tier can hold several models, from any mix of providers, in order of preference:

```jsonc
"routing": {
  "local":  ["laptop", "gpu-box"],     // Ollama on this machine, then vLLM on the team's GPU server
  "remote": ["sol", "deepseek-pro"]    // OpenAI first, DeepSeek if OpenAI is down
}
```

Within a tier the router uses the first model that is reachable and whose context window fits the prompt. A prompt too big for the laptop model goes to the GPU box (`rule: context-fit`), and a laptop server that's down hands over to the next one (`rule: fallback`), before anything is sent to a paid provider. A single alias (`"local": "laptop"`) works too.

The goal is to do most of the work locally and pay only for the calls that need a stronger model. The router makes that decision for each step of the agent loop, not once per session, and tells the user why.

## Decision pipeline

`Router.decide()` in `packages/router/src/router.ts` is a pure function of its input. The first matching rule picks a target:

| # | Rule (`rule` in events) | Fires when | Target |
|---|---|---|---|
| 1 | `user-override` | The prompt was sent with `route: local` or `route: remote` | That tier |
| 0 | `refusal-fallback` | The last remote call ended in `refusal`; retry on the next remote model not yet refused this turn | remote |
| 1 | `escalation-declined` | An `ask` escalation was just declined (or the run is headless) | local |
| 2 | `mode` | `routing.mode` is `local-only` or `remote-only` | That tier |
| 3 | `agent-pin` | The agent's definition names a model alias (`model: haiku`) or a tier (`model: local`, `route: remote`) | That model or tier |
| 4 | `context-overflow` | Input tokens exceed `escalation.contextHeadroom` × the `contextWindow` of every local model (see [Counting tokens](#counting-tokens)) | remote (counts as an escalation) |
| 5 | `sticky` | The session escalated within the last `escalation.stickyTurns` model calls | remote |
| 6 | `classifier` | `routing.classifier` is set and rated the turn's prompt `escalateOn` or harder, and `escalation.policy` is `auto` (or the user approved an `ask`) | remote (counts as an escalation) |
| 7 | `escalation` | A quality signal crossed its threshold (below) and `escalation.policy` is `auto`, or the user approved an `ask` | remote |
| 8 | `default` | Nothing else matched | local (remote if no local model is configured) |

A tier pin in an agent definition (`route: local`) is a preference: if that tier has no model configured, the router skips the pin. A user override (`--route local`) or `mode: local-only` with no local model is blocked with a pointer to `harness init`.

Whichever rule picks a tier, the model within it comes from that tier's list: the first that's reachable and fits. When that isn't the first model listed, the decision says so with `rule: context-fit` (an earlier model's window is too small) or `rule: fallback` (an earlier model's server is down), and the reason names both models.

Four guards then run on the chosen target:

- **Privacy** (`rule: privacy`). A session holding private content (a `privacy.localOnlyPaths` match, or a secret under `privacy.secrets: block`) never goes remote, whatever picked the target: not for a user override, `remote-only` mode, an agent pin, or a fallback when the local server is down. The call runs on a local model or is blocked. See [privacy.md](privacy.md).

- **Agent budget** (`rule: agent-budget`). A subagent invocation with `budgetUsd` (its own or `subagents.budgetUsd`) that has spent it, counting its own subagents, continues locally; with no local model it's stopped and its parent is told why. Nested subagents count against every budgeted invocation above them.

- **Budget** (`rule: budget`). If the target is remote, the user didn't explicitly ask for remote, and daily or monthly spend has reached `routing.budget`, the call stays local (`onExceeded: local`) or is refused (`onExceeded: block`).
- **Availability** (`rule: fallback`). If every model in the chosen tier failed its health check, the call moves to the other tier per `routing.fallback`. If that's also unavailable or over budget, the call is blocked with an explanation.

## Pre-routing classifier

Escalation is normally reactive: the local model has to struggle first. The optional classifier lets obviously hard prompts start remote. Before the first call of a turn, a small local model rates the prompt `easy`, `medium`, or `hard` with a short reason, and the router's `classifier` rule escalates ratings at or above `escalateOn`.

```jsonc
"routing": {
  "classifier": { "model": "tiny", "escalateOn": "hard", "timeoutMs": 1500 }
}
```

- Off unless configured. `model` must be a local model alias, so rating every prompt never costs money. A small, fast, non-thinking model works best.
- It runs only when its answer could change anything: automatic routing, no agent pin, not already sticky, and a remote model to escalate to.
- A classifier that doesn't answer within `timeoutMs`, errors, or gives an unreadable answer is ignored for that turn.
- It follows `escalation.policy`: `ask` prompts first, and `off` ignores the rating.
- The rating call is recorded in the usage ledger as `classify` (local, free), and the escalated call as `classifier`, so `harness usage --by rule` shows what it costs.

`bun scripts/eval-classifier.ts --model <name>` measures precision and recall on the labeled prompts in `tests/classifier/labeled.jsonl`. The nightly live workflow runs it and posts the numbers in the job summary.

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
- `ask`: emit `escalation.requested`. The TUI and VS Code show "Escalate to gpt-6-sol (≈ $0.04)? 3 consecutive tool errors [y/n]". Declining keeps the turn local. Headless runs always decline.

The estimate covers the escalated call plus the `stickyTurns` calls that follow it: the prompt at the model's input price, this session's mean output per call (800 tokens until there's history), and, for the follow-ups, the prefix read from the provider's prompt cache. It aims to be within 2x of the bill, not exact. Models without a known price (see `models.<alias>.price`) get no estimate.
- `off`: never escalate on quality signals. Context overflow and outages still route remote, because the local model can't take those calls at all.

## Budgets and savings

Every model call is written to the usage ledger with its cost. Local calls cost $0 but also record `savingsUsd`, which is what the same tokens would have cost on the configured remote model (`routing.remote`). `harness usage`, `/usage`, and the VS Code status bar report spend against budget and the running savings figure.

Each entry also records the routing `rule` and the `agent`, so you can see why money was spent:

```sh
harness usage --period week --by rule    # escalation vs. context-overflow vs. sticky ...
harness usage --by agent                 # which agents cost the most
harness usage --by model --json
```

The remote cache hit rate (cached input tokens over all remote input tokens) is shown alongside. A low rate on long remote runs usually means something is changing the prompt prefix.

Prices come from the model catalog (`packages/providers/src/catalog.ts`: list prices for Anthropic, OpenAI, and DeepSeek models). Bedrock, Vertex, resellers, and DeepSeek off-peak pricing differ, so override per model with `models.<alias>.price` when accuracy matters.

## Switching models mid-session

A session's transcript is provider-neutral and append-only. When a turn moves between models:

- **Reasoning** (Claude thinking blocks, DeepSeek `reasoning_content`) is replayed only to the exact provider and model that produced it. Other models never receive it.
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
  "local": ["local"],             // model aliases for local calls, in order of preference
  "remote": ["remote"],           // model aliases for remote calls; the first is the savings reference
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

## Long sessions

Before routing each step, the engine checks the prompt against `compaction.threshold` (0.7) of the largest local window. Past it, older messages are summarized into an appended marker and requests carry the summary plus the recent part of the conversation verbatim, so a long session keeps fitting the local model instead of drifting into `context-overflow` and staying remote. Summaries are written by a local model; a remote one is used only when no local model is reachable, routing allows remote, and the budget isn't spent, and then it shows as `rule: compaction`. The full transcript is never changed. Design: [ADR 0008](adr/0008-append-only-compaction.md).

## Counting tokens

The prompt size behind `context-overflow` and cost estimates comes from a BPE tokenizer (o200k) run over the system prompt, tool schemas, and transcript. Counts are cached per message, which is safe because transcripts are append-only, so each step only tokenizes what's new.

No single tokenizer matches every model, so when the estimate is within 20% of the local threshold, where the difference could flip the decision, the engine asks the local server for an exact count with the model's own tokenizer: llama.cpp and vLLM expose `/tokenize`. Servers without it (Ollama, LM Studio) keep the estimate. Hosted APIs are never asked; their windows are large enough that the estimate decides nothing close. `route.decided` reports the count it used as `inputTokens`.

## Refusals

A hosted model can decline a request (`stop_reason: refusal`, often from a safety classifier on benign security or biology work). Harness handles that the same way for every provider: the refused output is discarded, not added to the transcript, and the call is retried on the next model in `routing.remote` (`rule: refusal-fallback`). A model that refused is skipped for the rest of that user turn. Both calls are billed and appear in the usage ledger. With no other remote model configured, the turn ends as a refusal.

Where a provider offers its own fallback, Harness uses it too. On the first-party Anthropic API, requests carry `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), so a classifier decline is retried server-side on the model Anthropic recommends for that category, in the same request. The adapter keeps the text streamed before the switch, drops the declining model's thinking and tool calls, records the model that actually answered for billing, and logs the switch. A model that rejects the parameter is sent it once and never again. Set `providers.<id>.refusalFallback: "off"` to rely on the router alone. Bedrock and Vertex don't offer server-side fallback, so they use the router's chain.

A refusal from a local model is a quality signal instead: it counts as a failed local turn and escalates per `escalation.policy`.

## Prompt caching and stickiness

Remote calls are cheapest when they reuse the provider's prompt cache, which only works if each request starts with exactly the bytes of the previous one. Harness keeps that prefix stable: the system prompt is frozen when a session starts, tools are always sent in the same order, and the transcript is append-only. A test (`prompt caching` in `engine.test.ts`) checks that consecutive requests share a byte-identical prefix.

The engine also checks it at runtime. When a follow-up call to the same remote model, within five minutes and with at least 4,096 input tokens, reads nothing from the cache, it logs one warning per session: either the provider doesn't cache that model or something is changing the prefix. `harness usage` reports the remote cache hit rate.

Stickiness (`escalation.stickyTurns`) is a fixed number of model calls, not tied to cache state. We considered extending it while the remote cache is warm and decided against it: a warm cache makes a remote call cheaper, but a local call is still free, and stickiness exists to give a struggling task a few steps on the stronger model, not to save money. When routing returns to local and later escalates again, the first remote call may rewrite the cache; that cost is visible per rule in `harness usage --by rule`.

