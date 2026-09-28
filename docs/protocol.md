# Engine protocol

Every client, including our own, talks to the engine over this protocol. It's JSON-RPC 2.0 with one JSON object per line (NDJSON). The source of truth is `packages/protocol/src/methods.ts`; this page is the overview.

## Connecting

```sh
harness serve --stdio     # one client over stdin/stdout
harness serve --socket    # the shared workspace daemon; many clients (see architecture.md)
```

Daemon clients read the socket and token from the daemon info file (`connectDaemon` in `@harness/client` does all of this) and pass `token` in `initialize`.

Write requests to stdin and read responses and notifications from stdout. stderr carries human-readable logs. The first request must be `initialize`:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"client":{"name":"my-client","version":"1.0"},"workspaceRoot":"/path/to/repo"}}
```

From TypeScript, use `@harness/client`:

```ts
import { HarnessClient, spawnEngine } from '@harness/client';

const client = new HarnessClient(spawnEngine({ command: 'harness', cwd: root }));
await client.initialize({ name: 'my-client', version: '1.0' }, root);
const session = await client.request('session.create', {});
client.on((event) => { /* ... */ });
await client.request('session.prompt', { sessionId: session.id, text: 'hello' });
```

## Methods

| Method | Params | Result |
|---|---|---|
| `initialize` | `protocolVersion`, `client`, `workspaceRoot` | Engine version, models, agents, and `org` when an organization policy applies |
| `session.create` | `agent?`, `title?` | `SessionSummary` |
| `session.list` | none | Top-level sessions |
| `session.get` | `sessionId` | Summary and full transcript |
| `session.prompt` | `sessionId`, `text`, `route?` (`auto`\|`local`\|`remote`) | `{ turnId }`, returned immediately; progress arrives as events. `attachments?` adds context: `{kind: "file", path, startLine?, endLine?}` (read from the workspace by the engine) or `{kind: "text", label, text}`. These, and `@path` mentions in the text, become user-message text parts marked `attachment`. |
| `session.cancel` | `sessionId` | `{ cancelled }` (also cancels subagents) |
| `session.compact` | `sessionId` | `{ compacted }`: summarize earlier messages now. `SessionBusy` while a turn runs |
| `permission.respond` | `requestId`, `decision` (`allow_once`\|`allow_always`\|`deny`) | `{ ok }` |
| `escalation.respond` | `requestId`, `approve` | `{ ok }` |
| `agents.list` | none | `AgentSummary[]` |
| `mcp.list` | none | `{ servers }`: each MCP server's `state` (`connected`, `failed`, `disabled`, `untrusted`), tool count, and error |
| `usage.get` | `period?`: `today` \| `week` \| `month` (default); or `sessionId?` for one session and its subagents over their whole life (the receipt) | Spend, savings, the `referenceModel` savings are measured against, budget, remote cache hit rate, and breakdowns `byRule`, `byAgent`, `byModel` |
| `shutdown` | none | `{ ok }`; the engine then exits (stdio) |

## Events

Sent as notifications: `{"jsonrpc":"2.0","method":"event","params":{...}}`. Every event except `log` carries `sessionId`. Events from subagents also carry `parentSessionId`.

| `type` | Meaning |
|---|---|
| `turn.started` / `turn.completed` | Turn boundaries; `completed` has `stopReason` |
| `route.decided` | Tier, model, `rule`, and a human-readable `reason` for this step |
| `text.delta` / `reasoning.delta` | Streaming output |
| `tool.started` / `tool.completed` | Tool calls, with output and `isError`. `private` on `completed` says the result carried private content, so the session now stays local |
| `secrets.redacted` | Secrets were replaced with placeholders in a request to a remote model; `kinds` names each one (repeats included) and `model` the recipient. Sent only when a request contains more than the previous one |
| `permission.requested` | Waiting on `permission.respond`; for edits, `preview` is a unified diff (may be truncated) and `proposed` the complete new file |
| `permission.resolved` / `escalation.resolved` | The request was answered (by any client) or cancelled; clients clear their prompts |
| `escalation.requested` | Waiting on `escalation.respond` (policy `ask`). `estimatedCostUsd` is the rough cost of approving, when the target model has a known price |
| `subagent.started` / `subagent.completed` | A `task` call spawned or finished a child session; `background: true` when the parent didn't wait |
| `usage.updated` | Cumulative session usage, cost, and `savingsUsd` |
| `context.compacted` | Earlier messages were summarized: how many, and the prompt size before and after. The transcript gains a `compaction` part (never sent to models) |
| `error` | Something failed; the turn may continue or end |
| `config.updated` | Configuration changed while running (e.g. an organization policy update); carries `org` and human-readable `notes` |
| `log` | Engine diagnostics |

Clients should fold events with `reduce()` from `@harness/client/view` rather than writing their own interpretation.

## Errors

JSON-RPC error codes: standard codes `-32700` to `-32603`, plus `-32000` not initialized, `-32001` session not found, `-32002` session busy, `-32003` provider unavailable, and `-32004` budget exceeded.

## Versioning

`PROTOCOL_VERSION` is an integer, and `initialize` fails on a mismatch.

- **Additive changes** (new method, new event type, new optional field) don't bump the version. Clients must ignore unknown event types and fields.
- **Breaking changes** (removing or renaming anything, changing semantics) bump the version. The VS Code extension and CLI ship together, but third-party clients may not.
