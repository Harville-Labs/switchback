# Telemetry

Harness can send anonymous daily usage statistics to Harville Labs. It's **off unless you turn it on**, and nothing is collected while it's off.

```sh
harness telemetry            # status: on or off, endpoint, what has been sent
harness telemetry on         # opt in
harness telemetry off        # opt out; pending counters are deleted
harness telemetry preview    # print exactly what the next upload would contain
```

`harness init` asks once. The answer is always saved to your user config (`telemetry.enabled`), never to a project's config: a repository can turn telemetry **off** for everyone who works in it, but it can never turn it on.

## What it's for

Local-first routing only works if the defaults are right: when to escalate, how often the local model gets stuck, what running locally actually saves. These numbers tell us that across real use, not just our own machines.

## What is sent

One report per complete day, only for days after you opted in (and, on the day you opted in, only what happened afterwards). Reports are built from the usage ledger and a few counters. Every field:

| Field | Contents |
|---|---|
| `schema`, `version`, `os`, `arch` | Report format, Harness version, `darwin`/`linux`/`win32`, CPU architecture |
| `installId` | A random UUID created when you first opt in. It identifies an installation, not a person, and is kept if you opt out and back in |
| `day` | The UTC date the report covers |
| `calls` | Model calls by tier: `{ local, remote }` |
| `tokens` | Token totals by tier (remote split into input, output, cache read, cache write) |
| `costUsd`, `savingsUsd`, `allRemoteUsd` | Remote spend, estimated savings, and what running everything remote would have cost (the [savings receipt](routing.md#budgets-and-savings), summed) |
| `byRule` | Calls per routing rule (`default`, `escalation`, `privacy`, ...) by tier, with cost. Rules are names Harness defines; anything else is `other` |
| `remoteModels` | Remote calls per model, for models in the public catalog (`claude-opus-5`, `gpt-6-sol`, ...). Any other model is `custom` |
| `providerTypes` | Configured provider types (`ollama`, `anthropic`, `openai-compatible`, ...) |
| `features` | How Harness is set up: counts of local and remote models, escalation policy, whether the classifier, compaction, private paths, budgets, and an organization are in use, the secret-scanning mode, and counts of MCP servers and runtimes |
| `turns` | How top-level turns ended (`end_turn`, `error`, `cancelled`, ...) |
| `errors` | Number of error events |
| `crashes` | Up to 5 crashes: error class, a scrubbed message (paths, URLs, quoted strings, and long numbers removed; 200 characters at most), and stack frames reduced to function names and Harness's own source file names |

## What is never sent

Prompts, model output, code, file names or paths, tool inputs or output, agent names, model aliases, provider IDs, server URLs, local model names, your username, or your hostname. (The server sees your IP address, as with any HTTPS request; reports don't contain it.) A test in `packages/engine/src/telemetry.test.ts` runs a real session full of distinctive names and checks that none of them appear in the report.

## Turning it off everywhere

Any of these keeps it off regardless of config files:

- `DO_NOT_TRACK=1` ([consoledonottrack.com](https://consoledonottrack.com))
- `HARNESS_TELEMETRY=0`
- In VS Code, `telemetry.telemetryLevel: off`: the extension starts the engine with `HARNESS_TELEMETRY=0`
- An organization policy with `"enforced": { "telemetry": { "enabled": false } }`

## How it's sent

When an engine starts (the TUI, `harness run`, `harness serve`), it uploads any complete days that are due in one HTTPS `POST` of `{ "reports": [...] }` to `telemetry.endpoint` (default `https://harness.harville.ai/api/telemetry/v1`), in the background with a 5-second timeout. A failure is silent and retried next time; at most 30 days are kept pending. Counters live in `telemetry-counters.jsonl` in the data directory, readable only by you.
