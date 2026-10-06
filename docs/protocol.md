# Engine protocol

Every client, including our own, talks to the engine over this protocol. It's JSON-RPC 2.0 with one JSON object per line (NDJSON). The source of truth is `packages/protocol/src/methods.ts`; this page is the overview.

## Connecting

```sh
switchback serve --stdio     # one client over stdin/stdout
switchback serve --socket    # the shared workspace daemon; many clients (see architecture.md)
```

Daemon clients read the socket and token from the daemon info file (`connectDaemon` in `@switchback/client` does all of this) and pass `token` in `initialize`.

Write requests to stdin and read responses and notifications from stdout. stderr carries human-readable logs. The first request must be `initialize`:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"client":{"name":"my-client","version":"1.0"},"workspaceRoot":"/path/to/repo"}}
```

From TypeScript, use `@switchback/client`:

```ts
import { SwitchbackClient, spawnEngine } from '@switchback/client';

const client = new SwitchbackClient(spawnEngine({ command: 'switchback', cwd: root }));
await client.initialize({ name: 'my-client', version: '1.0' }, root);
const session = await client.request('session.create', {});
client.on((event) => { /* ... */ });
await client.request('session.prompt', { sessionId: session.id, text: 'hello' });
```

## Methods

| Method | Params | Result |
|---|---|---|
| `initialize` | `protocolVersion`, `client`, `workspaceRoot` | Engine version, models, agents, and `org` when an organization policy applies |
| `session.create` | `agent?`, `title?`, `permissionMode?` | `SessionSummary` (with the mode in `permissionMode`) |
| `session.list` | none | Top-level sessions |
| `session.get` | `sessionId` | Summary and full transcript |
| `session.prompt` | `sessionId`, `text`, `route?` (`auto`\|`local`\|`remote`), `review?` (boolean; overrides `review.mode`), `delivery?` (`queue`\|`interrupt`) | `{ turnId, queued? }`, returned immediately; progress arrives as events. While a turn runs, the prompt is queued for the model's next step (`queued` is its ID; anything still queued when the turn ends starts the next one), or with `delivery: "interrupt"` the running turn is cancelled and this prompt starts at once. `session.cancel` drops the queue. `attachments?` adds context: `{kind: "file", path, startLine?, endLine?}` (read from the workspace by the engine) or `{kind: "text", label, text}`. These, and `@path` mentions in the text, become user-message text parts marked `attachment`. |
| `session.checkpoints` | `{ sessionId }` | `CheckpointInfo[]`, oldest first: each turn's `turnId`, its prompt, when, and the files it changed with edit or write |
| `session.rewind` | `{ sessionId, turnId, restore: files\|conversation\|both }` | `{ files, session? }`: the files put back or removed, and with the conversation, the new session holding the history before that turn (the original is untouched) |
| `session.dequeue` | `{ sessionId, id }` | `{ removed }`. Withdraws a queued prompt before it's delivered |
| `session.cancel` | `sessionId` | `{ cancelled }` (also cancels subagents) |
| `session.compact` | `sessionId` | `{ compacted }`: summarize earlier messages now. `SessionBusy` while a turn runs |
| `permission.respond` | `requestId`, `decision` (`allow_once`\|`allow_always`\|`deny`), `save?` (`project`\|`user`) | `{ ok }`. `allow_always` grants the request's `rules` for the engine's lifetime; `save` also writes them to `.switchback/config.local.json` or the user config |
| `session.setMode` | `{ sessionId, mode }` (`default`\|`acceptEdits`\|`plan`\|`bypassPermissions`) | `{ mode }`. Applies to the session and its subagents; modes the organization rules out are refused. Emits `mode.changed` |
| `shells.list` | `{ sessionId? }` | `ShellInfo[]`: background shells, all or one session's |
| `shells.kill` | `{ shellId }` | `ShellInfo` |
| `permissions.list` | `{ sessionId? }` | `{ mode?, modes, levels, rules }`: the session's mode, the modes it may switch to, the category levels, and every rule with its `source` |
| `escalation.respond` | `requestId`, `approve` | `{ ok }` |
| `agents.list` | none | `AgentSummary[]` |
| `mcp.list` | none | `{ servers }`: each MCP server's `state` (`connected`, `failed`, `disabled`, `untrusted`), tool count, and error |
| `usage.get` | `period?`: `today` \| `week` \| `month` (default); or `sessionId?` for one session and its subagents over their whole life (the receipt) | Spend, savings, the `referenceModel` savings are measured against, budget, remote cache hit rate, and breakdowns `byRule`, `byAgent`, `byModel` |
| `shutdown` | none | `{ ok }`; the engine then exits (stdio) |
| `session.roles` | `{ sessionId }` | `SessionRoles`: `start`, `escalate`, `review` (`mode`, `models`), `subagents`, and which of them the session changed (`overridden`) |
| `session.setRoles` | `{ sessionId, start?, escalate?, review?, subagents?, save?, reset? }` | `SessionRoles` plus `savedTo` when `save` wrote the user config. Changes apply to the session and its subagents; `reset` drops them first; keys an organization enforces are refused. Emits `roles.updated` |
| `daemon.retire` | `{ token }` | `{ retired, reason? }`. Asks a shared daemon to exit so a newer Switchback can take over. Accepted before `initialize`, so it works across protocol versions. Refused while other clients are attached or a turn is running. |

## Events

Sent as notifications: `{"jsonrpc":"2.0","method":"event","params":{...}}`. Every event except `log` carries `sessionId`. Events from subagents also carry `parentSessionId`.

| `type` | Meaning |
|---|---|
| `turn.started` / `turn.completed` | Turn boundaries; `completed` has `stopReason` |
| `route.decided` | Tier, model, `rule`, and a human-readable `reason` for this step; `step`/`steps` (where the model is on the escalation ladder) and `stickyTurns` |
| `roles.updated` | A session's roles changed (`session.setRoles`), so every attached client can show them |
| `queue.updated` | The session's queued prompts changed (`queued`: id and text of each) |
| `queue.delivered` | A queued prompt reached the model at a step boundary; clients show it as the user's message then |
| `shell.updated` | A background shell started, exited, or was stopped (`shell`: id, command, status, exit code) |
| `mode.changed` | A session's permission mode changed (`session.setMode`, or a plan was approved) |
| `text.delta` / `reasoning.delta` | Streaming output |
| `tool.started` / `tool.completed` | Tool calls, with output and `isError`. `private` on `completed` says the result carried private content, so the session now stays local |
| `review.completed` | A review of the turn's local edits: `verdict` (`approve`, `revise`, or `skipped` with the reason in `summary`), `issues` (`file`, `line`, `severity`, `comment`), the reviewer `model`, and `round` |
| `secrets.redacted` | Secrets were replaced with placeholders in a request to a remote model; `kinds` names each one (repeats included) and `model` the recipient. Sent only when a request contains more than the previous one |
| `permission.requested` | Waiting on `permission.respond`; for edits, `preview` is a unified diff (may be truncated) and `proposed` the complete new file. `rules` is what `allow_always` would grant (absent when `askRule` names an ask rule, which asks every time); `plan` is set when the model asks to leave plan mode |
| `permission.resolved` / `escalation.resolved` | The request was answered (by any client) or cancelled; clients clear their prompts |
| `escalation.requested` | Waiting on `escalation.respond` (policy `ask`). `estimatedCostUsd` is the rough cost of approving, when the target model has a known price |
| `subagent.started` / `subagent.completed` | A `task` call spawned or finished a child session; `background: true` when the parent didn't wait |
| `usage.updated` | Cumulative session usage, cost, and `savingsUsd` |
| `context.compacted` | Earlier messages were summarized: how many, and the prompt size before and after. The transcript gains a `compaction` part (never sent to models) |
| `error` | Something failed; the turn may continue or end |
| `config.updated` | Configuration changed while running (e.g. an organization policy update); carries `org` and human-readable `notes` |
| `log` | Engine diagnostics |

Clients should fold events with `reduce()` from `@switchback/client/view` rather than writing their own interpretation.

## Errors

JSON-RPC error codes: standard codes `-32700` to `-32603`, plus `-32000` not initialized, `-32001` session not found, `-32002` session busy, `-32003` provider unavailable, and `-32004` budget exceeded.

## Versioning

`PROTOCOL_VERSION` is an integer, and `initialize` fails on a mismatch.

- **Additive changes** (new method, new event type, new optional field) don't bump the version. Clients must ignore unknown event types and fields.
- **Breaking changes** (removing or renaming anything, changing semantics) bump the version. The VS Code extension and CLI ship together, but third-party clients may not.
