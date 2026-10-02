# Routing and escalation

Switchback picks a model for every call the agent makes, not once per session, and says why. Models fill **roles** ([ADR 0015](adr/0015-role-based-routing.md)):

```jsonc
"routing": {
  "start":    ["laptop", "gpu-box"],        // where turns begin: the first that's up and fits
  "escalate": ["large", ["opus", "sol"]]    // the ladder: one step per escalation
}
```

- **`start`** is a chain of alternatives. A prompt too big for the laptop model goes to the GPU box (`rule: context-fit`), and a laptop server that's down hands over to the next one (`rule: fallback`).
- **`escalate`** is a ladder. Each step is a model, or a chain of alternatives for the same step (`["opus", "sol"]`: Anthropic, or OpenAI if Anthropic is down). Each escalation moves one step up from where the session is.

Any model can fill any role. Whether it's **local** (a model on your machine or network, free per token) or **remote** (a hosted model, billed per token) is a property of its provider, not of the role. It decides what costs money, what budgets cover, what `ask` prompts for, and what private content may reach. So all of these are ordinary configurations:

| Setup | `start` | `escalate` |
|---|---|---|
| Local first | `["fast"]` | `["large", "opus"]` |
| All local | `["fast"]` | `["large"]` |
| All remote | `["haiku"]` | `["sonnet", "opus"]` |
| Remote first, local backup | `["sonnet", "laptop"]` | `["opus"]` |

`routing.allowRemote: false` keeps remote models configured but unused: on a plane, or with a client's code. An organization's remote-off restriction sets it too.

The reviewer of local edits (`review.model`, [review.md](review.md)) and the default model for subagents (`subagents.model`, [subagents.md](subagents.md)) are roles as well, filled by any model.

## Decision pipeline

`Router.decide()` in `packages/router/src/router.ts` is a pure function of its input. Steps are numbered: 0 is `start`, 1 is the first `escalate` step, and so on. The first matching rule picks a target:

| # | Rule (`rule` in events) | Fires when | Target |
|---|---|---|---|
| 0 | `refusal-fallback` | The last call ended in `refusal` | Another model on the same step, else the next step up |
| 1 | `user-override` | The prompt was sent with `route: local` or `route: remote` (`/local`, `/remote`, `--route`) | The first model of that tier in role order |
| 1 | `escalation-declined` | An `ask` escalation was just declined (or the run is headless) | The step the session is on |
| 2 | `agent-pin` | The agent names a model alias (`model: haiku`) or a tier (`model: local`, `route: remote`) | That model, or the first of that tier in role order |
| 3 | `context-overflow` | The prompt exceeds `escalation.contextHeadroom` × the window of the model the session is on (see [Counting tokens](#counting-tokens)) | The first step up whose window fits, else the largest window above |
| 4 | `sticky` | The session escalated within the last `escalation.stickyTurns` calls | The step it reached; one step higher if the model there is struggling too |
| 5 | `classifier` | `routing.classifier` rated the turn's prompt `escalateOn` or harder | One step up |
| 6 | `escalation` | A quality signal crossed its threshold (below) | One step up |
| 7 | `default` | Nothing else matched | The `start` chain (the first step if `start` is empty) |

Rules 5 and 6 follow `escalation.policy`. Rules 3 to 6 count as escalations. A step that's down, too small for the prompt, or remote when remote isn't allowed is skipped on the way up.

A tier pin in an agent definition (`route: local`) is a preference: if no model of that tier is in a role, the router skips the pin. A user override (`--route local`) with no model of that tier is blocked with a pointer to `switchback init`.

Within a step, the model comes from that step's chain: the first that's reachable and fits. When that isn't the first one listed, the decision says so with `rule: context-fit` or `rule: fallback`, naming both models.

Then five guards run on the target. They only ever act on remote models; a local model is never redirected for cost or privacy:

- **Privacy** (`rule: privacy`). A session holding private content (a `privacy.localOnlyPaths` match, or a secret under `privacy.secrets: block`) never reaches a remote model, whatever picked it: a user override, an agent pin, an escalation, or an outage. The call runs on the nearest local model or is blocked. See [privacy.md](privacy.md).
- **Remote off** (`rule: remote-off`). With `routing.allowRemote: false`, a remote target runs on the nearest local model instead; an explicit `/remote` is refused.
- **Agent budget** (`rule: agent-budget`). A subagent invocation with `budgetUsd` (its own or `subagents.budgetUsd`) that has spent it, counting its own subagents, continues on the nearest local model; with none it's stopped and its parent is told why.
- **Budget** (`rule: budget`). If the target is remote, the user didn't explicitly ask for remote, and daily or monthly spend has reached `routing.budget`, the call moves to the nearest local model (`onExceeded: local`) or is refused (`onExceeded: block`).
- **Availability** (`rule: fallback`). If every model on the chosen step failed its health check, the call goes to the nearest other step that's up: higher steps first, then lower. The same rules apply to that step. `routing.fallback: "none"` blocks instead.

"Nearest local model" means the chosen step's local alternatives, then lower steps, then higher ones.

## Escalation ladder

```jsonc
"models": {
  "fast":  { "provider": "ollama", "model": "qwen3-coder:30b" },
  "large": { "provider": "gpu-box", "model": "qwen3-coder-480b" },
  "opus":  { "provider": "anthropic", "model": "claude-opus-5" }
},
"routing": { "start": ["fast"], "escalate": ["large", "opus"] }   // fast → large → opus
```

- Each escalation moves **one step** from where the session is. When `fast` gets stuck, the call goes to `large` (`3 consecutive tool errors; escalating to large (step 1 of 2)`). If `large` struggles too during its sticky calls, the next escalation goes to `opus`.
- Stickiness keeps the session on the step it reached for `stickyTurns` model calls; then routing starts again from `start`.
- Local steps are free: `ask` doesn't prompt for them, budgets don't cover them, and they work with `allowRemote: false` and in [private sessions](privacy.md).
- `policy: off` means no escalation on quality signals at any step.
- An alias that isn't under `models` is a config error, so a typo can't silently remove a step.

`switchback init` asks which models start and which escalate. `switchback doctor` shows the roles, each model's tier, and its context window.

## Pre-routing classifier

Escalation is normally reactive: the start model has to struggle first. The optional classifier lets obviously hard prompts start one step up. Before the first call of a turn, a small model rates the prompt `easy`, `medium`, or `hard` with a short reason, and the router's `classifier` rule escalates ratings at or above `escalateOn`.

```jsonc
"routing": {
  "classifier": { "model": "tiny", "escalateOn": "hard", "timeoutMs": 1500 }
}
```

- Off unless configured. `model` can be any alias; a small, fast, non-thinking local model keeps rating every prompt free. A remote classifier reads the prompt, so it follows the remote rules: never for a private session or with `allowRemote: false`, and its calls are billed.
- It runs only when its answer could change anything: automatic routing, no agent pin, not already sticky, and an escalation step to go to.
- A classifier that doesn't answer within `timeoutMs`, errors, or gives an unreadable answer is ignored for that turn.
- It follows `escalation.policy`: `ask` prompts first, and `off` ignores the rating.
- The rating call is recorded in the usage ledger as `classify`, and the escalated call as `classifier`, so `switchback usage --by rule` shows what each costs.

`bun scripts/eval-classifier.ts --model <name>` measures precision and recall on the labeled prompts in `tests/classifier/labeled.jsonl`. The nightly live workflow runs it and posts the numbers in the job summary.

## Quality signals

The engine reports what happens on each step to a per-session `SignalTracker`:

| Signal | Threshold (config key) | Meaning |
|---|---|---|
| Turn failed | any | Provider error, a local model's refusal, or `max_tokens` in the middle of a tool call |
| Loop detected | `escalation.loopThreshold` (3) | The same tool with the same arguments (key order ignored) within the last 20 calls |
| Malformed tool calls | `escalation.maxMalformedToolCalls` (2) | Unknown tool names or arguments that fail schema validation, in the current user turn |
| Consecutive tool errors | `escalation.maxConsecutiveToolErrors` (3) | Tools that ran and failed, back to back |

Signals reset after an escalation and when a new user prompt starts (except stickiness).

## Escalation policy

`routing.escalation.policy`:

- `auto` (default): escalate immediately and show the reason.
- `ask`: before escalating to a remote model, emit `escalation.requested`. The TUI and VS Code show "Escalate to gpt-6-sol (≈ $0.04)? 3 consecutive tool errors [y/n]". Declining keeps the session where it is. Headless runs always decline. Local steps never ask; they cost nothing.

The estimate covers the escalated call plus the `stickyTurns` calls that follow it: the prompt at the model's input price, this session's mean output per call (800 tokens until there's history), and, for the follow-ups, the prefix read from the provider's prompt cache. It aims to be within 2x of the bill, not exact. Models without a known price (see `models.<alias>.price`) get no estimate.
- `off`: never escalate on quality signals. Context overflow and outages still move, because the current model can't take those calls at all.

## Budgets and savings

Every model call is written to the usage ledger with its cost. Local calls cost $0 but also record `savingsUsd`: what the same call would have cost on the reference model, the first remote model in role order (`start`, then each `escalate` step). `switchback usage`, `/usage`, and the VS Code status bar report spend against budget and the running savings figure.

The savings figure is deliberately conservative. Run all-remote, most of each prompt would have been a cache read (the previous call in the session already sent it), so a local call that follows another within five minutes prices the repeated part of its prompt at the cache-read rate and only the new part at the input price. Output is priced at the output rate, with no cache-write premium. It's still an estimate: a remote model might have taken fewer or more steps, and local and remote tokenizers count differently.

**The receipt.** `/receipt` in the TUI, **Show Session Receipt** in VS Code, and the last line of `switchback run` show what one session cost (with its subagents) against what running it all on the reference model would have cost:

```
This session, including subagents
  local      $0.00   812k tokens in, 9k out
  remote     $0.42   64k tokens in, 3k out
  all-remote on claude-opus-5 would have cost ~$3.10
  saved    ~$2.68 (86%)
```

Each entry also records the routing `rule` and the `agent`, so you can see why money was spent:

```sh
switchback usage --period week --by rule    # escalation vs. context-overflow vs. sticky ...
switchback usage --by agent                 # which agents cost the most
switchback usage --by model --json
```

The remote cache hit rate (cached input tokens over all remote input tokens) is shown alongside. A low rate on long remote runs usually means something is changing the prompt prefix.

Prices come from the model catalog (`packages/providers/src/catalog.ts`: list prices for Anthropic, OpenAI, and DeepSeek models). Bedrock, Vertex, resellers, and DeepSeek off-peak pricing differ, so override per model with `models.<alias>.price` when accuracy matters.

## Switching models mid-session

A session's transcript is provider-neutral and append-only. When a turn moves between models:

- **Reasoning** (Claude thinking blocks, DeepSeek `reasoning_content`) is replayed only to the exact provider and model that produced it. Other models never receive it.
- **Tool call IDs** from local servers are normalized for the Messages API (`[a-zA-Z0-9_-]`) when translated.
- **Prompt caching** is per model. Switching from local to remote pays for the full prefix once. Stickiness (`stickyTurns`) exists partly so a session doesn't pay that cost on every alternate step. The system prompt and tool list are frozen per session to keep the cached prefix stable.

## Tuning

- **Start model too weak for tool use?** Lower `maxMalformedToolCalls` to 1, add a bigger local model as the first `escalate` step, or give tool-heavy agents a stronger model with `model:` while keeping `explore` local.
- **Escalating too often on long sessions?** Raise the local model's `contextWindow` to match what your server actually loads (Ollama defaults to a small `num_ctx`; set it in the Modelfile). Keep `contextHeadroom` below 1 to leave room for output.
- **Want approval for every dollar?** Use `policy: ask` plus a `dailyUsd` budget.
- **Offline, or working on a client's code?** `allowRemote: false` for guaranteed zero spend. To spare the machine instead, put remote models in `start`.

## Configuration reference

```jsonc
"routing": {
  "start": ["local"],             // where turns begin: a chain of alternatives
  "escalate": [["remote"]],       // the ladder; each step an alias or a chain of alternatives
  "allowRemote": true,            // false: never call a remote model
  "escalation": {
    "policy": "auto",             // auto | ask | off
    "maxConsecutiveToolErrors": 3,
    "maxMalformedToolCalls": 2,
    "loopThreshold": 3,
    "contextHeadroom": 0.85,
    "stickyTurns": 2
  },
  "classifier": { "model": "tiny", "escalateOn": "hard", "timeoutMs": 1500 },
  "budget": { "dailyUsd": 5, "monthlyUsd": 50, "onExceeded": "local" },
  "fallback": "nearest"           // nearest | none
}
```

There are no defaults for `start` and `escalate`: `switchback init` writes them, and an empty `start` with no escalation steps is reported by `switchback doctor`.

Keys from before roles fail validation with a pointer to their replacement: `routing.local` (now `start`), `routing.remote` (now an `escalate` step), `routing.mode` (now the roles themselves, or `allowRemote: false`), `escalation.via` (now `escalate`), and the object form of `routing.fallback`. Re-running `switchback init` rewrites them.

## Long sessions

Before routing each step, the engine checks the prompt against `compaction.threshold` (0.7) of the largest window in `start`. Past it, older messages are summarized into an appended marker and requests carry the summary plus the recent part of the conversation verbatim, so a long session keeps fitting the start model instead of drifting into `context-overflow` and staying up the ladder. Summaries are written by a local model in a role; a remote one is used only when no local model is reachable, remote is allowed, and the budget isn't spent, and then it shows as `rule: compaction`. The full transcript is never changed. Design: [ADR 0008](adr/0008-append-only-compaction.md).

## Counting tokens

The prompt size behind `context-overflow` and cost estimates comes from a BPE tokenizer (o200k) run over the system prompt, tool schemas, and transcript. Counts are cached per message, which is safe because transcripts are append-only, so each step only tokenizes what's new.

No single tokenizer matches every model, so when the estimate is within 20% of a local start model's threshold, where the difference could flip the decision, the engine asks the local server for an exact count with the model's own tokenizer: llama.cpp and vLLM expose `/tokenize`. Servers without it (Ollama, LM Studio) keep the estimate. Hosted APIs are never asked; their windows are large enough that the estimate decides nothing close. `route.decided` reports the count it used as `inputTokens`.

## Refusals

A hosted model can decline a request (`stop_reason: refusal`, often from a safety classifier on benign security or biology work). Switchback handles that the same way for every provider: the refused output is discarded, not added to the transcript, and the call is retried on another model on the same step, else the next step up (`rule: refusal-fallback`). A model that refused is skipped for the rest of that user turn. Both calls are billed and appear in the usage ledger. With no other model to take it, the turn ends as a refusal.

Where a provider offers its own fallback, Switchback uses it too. On the first-party Anthropic API, requests carry `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), so a classifier decline is retried server-side on the model Anthropic recommends for that category, in the same request. The adapter keeps the text streamed before the switch, drops the declining model's thinking and tool calls, records the model that actually answered for billing, and logs the switch. A model that rejects the parameter is sent it once and never again. Set `providers.<id>.refusalFallback: "off"` to rely on the router alone. Bedrock and Vertex don't offer server-side fallback, so they use the router's chain.

A refusal from a local model is a quality signal instead: it counts as a failed turn and escalates per `escalation.policy`.

## Prompt caching and stickiness

Remote calls are cheapest when they reuse the provider's prompt cache, which only works if each request starts with exactly the bytes of the previous one. Switchback keeps that prefix stable: the system prompt is frozen when a session starts, tools are always sent in the same order, and the transcript is append-only. A test (`prompt caching` in `engine.test.ts`) checks that consecutive requests share a byte-identical prefix.

The engine also checks it at runtime. When a follow-up call to the same remote model, within five minutes and with at least 4,096 input tokens, reads nothing from the cache, it logs one warning per session: either the provider doesn't cache that model or something is changing the prefix. `switchback usage` reports the remote cache hit rate.

Stickiness (`escalation.stickyTurns`) is a fixed number of model calls, not tied to cache state. We considered extending it while the remote cache is warm and decided against it: a warm cache makes a remote call cheaper, but a local call is still free, and stickiness exists to give a struggling task a few steps on the stronger model, not to save money. When routing returns to `start` and later escalates again, the first remote call may rewrite the cache; that cost is visible per rule in `switchback usage --by rule`.

