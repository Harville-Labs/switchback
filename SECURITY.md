# Security

## Reporting a vulnerability

Email **security@harville.ai** with a description, reproduction steps, and impact. Please don't open a public issue. We acknowledge within two business days and aim to resolve high-severity issues within 30 days.

## Scope

Switchback executes model-generated tool calls on the user's machine. We treat these as security bugs:

- A path that escapes the workspace through file tools
- A mutating tool running without the configured permission check
- Tool execution from truncated or refused model output
- Credentials written to logs, session files, the usage ledger, or protocol events
- Remote spend beyond configured budgets without an explicit user request
- The VS Code webview executing content from model output (script injection)
- Organization policy not applied, or bypassed without signing out or modifying the program
- Organization credentials or the cached policy readable by other local users

Known and documented limitations, which are not vulnerabilities but are tracked for hardening:

- `bash` runs in an OS sandbox on macOS and Linux (docs/permissions.md#sandbox): writes only to the workspace, temp, and package caches; no reads of common credential directories; network as configured. It is not sandboxed on Windows, or where the sandbox's dependencies are missing and `bash.sandbox.mode` is `auto`. A command the user approves with `unsandboxed: true` runs outside it.
- Session files and the usage ledger are stored unencrypted under the user's data directory.
- Organization policy is enforced on the client; a user who controls their machine can sign out. See [docs/organizations.md](docs/organizations.md#security-and-enforcement) for gateway-based hard enforcement.

## Design notes

See [docs/permissions.md](docs/permissions.md) and the security section of [docs/architecture.md](docs/architecture.md).
