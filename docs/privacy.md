# Privacy: what never leaves your machine

Local models see everything; remote models see only what Harness sends them. Two settings control what that is.

```jsonc
"privacy": {
  "localOnlyPaths": ["secrets/", "*.pem", ".env*", "customers/**/*.csv"],
  "secrets": "redact"
}
```

Both are ordinary config keys, so an organization can enforce them (see [organizations.md](organizations.md)).

## Private paths

`privacy.localOnlyPaths` lists globs relative to the workspace. A pattern without a slash matches by file name anywhere, as in `.gitignore` (`*.pem`, `.env*`); a trailing slash means everything under a directory.

When content from a matching file enters a session, the session is **pinned local for the rest of its life**:

- The router's `privacy` guard runs before every other guard and keeps every model call on a local model. It overrides every rule, including an explicit `/remote`, `--route remote`, `routing.mode: remote-only`, agent pins, and escalation. With no local model available, the call is blocked rather than sent.
- Nothing is asked: an `ask` escalation would be pointless, so the router keeps the turn local and says why.
- Compaction summaries are written locally, never by a remote model.
- Subagents started by a private session are private from the start, since their brief was written with the private context. A subagent that sees private content makes its report private, which pins its parent too.
- External runtimes ([ADR 0009](adr/0009-external-agent-runtimes.md)) are remote, so a private session can't start one. A runtime that isn't private still can't touch private files: its tool calls on them are refused whatever the permission settings say.

The pin never lifts, not even after compaction: the local model's later messages may repeat what it saw. To use remote models again, start a new session.

The mark lives in the transcript (`private` on the tool result or attachment), so it survives restarts, and both clients show it: `🔒 stays local` on the tool row, and `🔒 local only` in the status line.

### What counts as content entering a session

| Source | Detected by |
|---|---|
| `read`, `edit`, `write` | The file path |
| `grep` | Any matching line from a private file in the output |
| `@file` mentions and editor attachments | The file path |
| `bash` | Paths the command names (`cat secrets/db.yml`, `FILE=secrets/x ./run`) |
| Subagent reports | The subagent's own session was private |

`glob` returns file names, not contents, so listing private files doesn't pin a session.

**Limits.** Detection for `bash` is by the paths a command names. A command that reads a private file indirectly (a script, `find . -exec cat`, a program's own config loading) isn't detected. MCP tools aren't inspected. If that matters to you, set `permissions.bash` to `ask` or `deny`, or use `routing.mode: local-only` for that project.

## Secrets

`privacy.secrets` scans everything about to be sent to a remote model for credentials: API keys and tokens for major providers (GitHub, Slack, OpenAI, Anthropic, AWS, GCP, npm, and more), private keys, and database connection strings with passwords. Scanning uses [secretlint](https://github.com/secretlint/secretlint)'s recommended rules.

| Value | Effect |
|---|---|
| `redact` (default) | Each secret is replaced with a placeholder such as `[redacted GITHUB_TOKEN]` in the copy sent to the remote model. Clients show a notice naming what was redacted. |
| `block` | A conversation containing a secret stays local, like a private path (rule `privacy`). |
| `off` | No scanning. |

Redaction changes only what's sent, never the stored transcript, and the local model still sees the real values. It's deterministic, so consecutive requests keep an identical prefix and still hit the provider's prompt cache. A remote model can't use a value it never saw: if it needs to edit a line containing a secret, the edit won't match and the model will say so.

Scanning finds credentials with a recognizable format. It won't catch a password in plain prose or a custom token format; use `localOnlyPaths` for files that hold those.
