# Security

## Reporting a vulnerability

Email **security@harville.ai** with a description, reproduction steps, and impact. Please don't open a public issue. We acknowledge within two business days and aim to resolve high-severity issues within 30 days.

## Scope

Harness executes model-generated tool calls on the user's machine. We treat these as security bugs:

- A path that escapes the workspace through file tools
- A mutating tool running without the configured permission check
- Tool execution from truncated or refused model output
- Credentials written to logs, session files, the usage ledger, or protocol events
- Remote spend beyond configured budgets without an explicit user request
- The VS Code webview executing content from model output (script injection)

Known and documented limitations, which are not vulnerabilities but are tracked for hardening:

- Once allowed, `bash` can do anything the user can. OS-level sandboxing is on the roadmap.
- Session files and the usage ledger are stored unencrypted under the user's data directory.

## Design notes

See [docs/permissions.md](docs/permissions.md) and the security section of [docs/architecture.md](docs/architecture.md).
