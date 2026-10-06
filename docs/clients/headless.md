# Scripts and CI: `switchback run`

`switchback run` runs one prompt with no interface and exits, for scripts, git hooks, and CI. The prompt is the argument, or stdin when there isn't one.

```sh
switchback run "summarize what changed in this branch"
git diff main | switchback run "review this diff for bugs" --output json
switchback run --yes --allow "bash(bun test:*)" --max-steps 30 "make the failing tests pass"
```

## Options

| Option | Meaning |
|---|---|
| `--output text` | The default: the answer on stdout, what's happening (routes, tools, the cost) on stderr |
| `--output json` | One object on stdout at the end: `result` (the answer), `stopReason`, `denied`, `exitCode`, `sessionId`, `costUsd`, `savingsUsd`, `usage` |
| `--output events` | Every [protocol event](../protocol.md) as a line of JSON, as it happens |
| `--yes` | Approve tool calls the permission levels would ask about. Without it, they're refused |
| `--allow <rule>`, `--deny <rule>` | [Permission rules](../permissions.md#rules) for this run only, added to the config's; repeatable. Deny rules refuse even with `--yes` |
| `--permission-mode <mode>` | `default`, `acceptEdits`, `plan`, or `bypassPermissions` for this run |
| `--max-steps <n>` | At most `n` model calls (`maxStepsPerTurn`) |
| `--instructions <text>` | Added to this run's system prompt |
| `-c`, `--continue` / `--session <id>` | Continue the latest saved session, or a given one, instead of starting fresh |
| `--route`, `--agent`, `--review` | As in the terminal UI |

A run never spends money it wasn't told it could: an escalation that would ask is declined, as in every headless run ([routing.md](../routing.md)).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The turn finished |
| 1 | It failed: an error, a refusal, or the step limit |
| 2 | Usage error (a bad flag or rule); nothing ran |
| 3 | It finished, but a tool call was refused (by a rule, a hook, or no `--yes`). Check whether the result is what you wanted |
