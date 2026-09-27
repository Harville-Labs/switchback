# Permissions and safety

Harness runs tools on the user's machine, so every tool call passes three checks.

## 1. Validation

Tool inputs come from a model and are untrusted. Each tool has a Zod schema. Invalid input is never executed; the model receives the validation error instead, and the failure counts as a malformed-call signal for routing. Responses that stopped on `max_tokens` or `refusal` never have their tool calls executed, because the input may be truncated.

## 2. Workspace confinement

File tools resolve paths against the workspace root and reject anything outside it, including `..`, absolute paths elsewhere, and symlinks that point out of the workspace. The deepest existing ancestor is canonicalized with `realpath` before the check.

The `bash` tool runs with the workspace as its working directory but isn't sandboxed. It can do anything the user can. That's why it defaults to `ask`. OS-level sandboxing is on the roadmap.

## 3. Permission policy

| Category | Tools | Default |
|---|---|---|
| `read` | read, glob, grep | `allow` |
| `edit` | write, edit | `ask` |
| `bash` | bash | `ask` |
| `mcp` | tools from MCP servers (`mcp__<server>__<tool>`) | `ask`; a server's `permission` setting overrides it, except that a category-level `deny` always wins |
| (none) | task | always allowed; the subagent's own tools are checked individually |

With `ask`, the engine emits `permission.requested` and waits. For `edit` and `write` the request includes a unified diff of the change, which both clients show in the prompt. If building the preview shows the call would fail (for example `oldString` isn't in the file), the model gets that error and you aren't asked. Clients offer:

- **Allow once**: this call only.
- **Always**: every call in this category for the rest of the engine's lifetime. For MCP tools, "always" covers that one server's tools.
- **Deny**: the model is told the user declined and not to retry.

Cancelling the turn denies any pending request. Headless `harness run` denies `ask` permissions unless you pass `--yes`.

## Cost safety

Remote calls cost money, so they have their own guard rails:

- Budgets (`routing.budget`) keep automatic escalations local once a limit is reached.
- `escalation.policy: ask` requires approval before each escalation.
- Headless runs never approve an `ask` escalation.
- Every remote call appears in the UI with its reason and in the usage ledger with its cost.
