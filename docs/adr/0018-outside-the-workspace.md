# 0018: Files outside the workspace: reads as usual, edits ask

**Status:** Accepted · 2026-10-09

## Context

File tools refused every path outside the workspace (`resolveInWorkspace`, invariant 6). That kept the model in its lane, but it also made ordinary work impossible: reading a sibling repository, checking notes in `~/notes`, or changing your own `~/.switchback/config.json` when you ask the model to change a setting. The only way around it was an unsandboxed shell command, which is worse: the prompt shows a command rather than a diff, and nothing checks what it writes.

Permission rules already accept absolute paths (`read(~/.ssh/**)`, `read(//etc/hosts)`), but only the sandbox used them, because the file tools never let such a path reach the policy.

## Decision

File tools resolve any path (`resolveFile`: `~/` expanded, symlinks canonicalized) and the permission gate decides what may happen outside the workspace.

- **Off limits in every mode:** Switchback's data directory (sessions, ledger, checkpoints), `~/.switchback/auth.json`, and the credentials in `bash.sandbox.denyRead`. The sandbox already keeps commands out of these; now the file tools match it. They're refused even in `bypassPermissions`. Credentials are refused even inside the workspace; the data directory isn't refused to a session whose own root is in it (a subagent's worktree). Places are compared after resolving symlinks, so a symlinked home or `SWITCHBACK_HOME` can't hide them.
- **Reads outside the workspace are first-class.** They follow `permissions.read` (`allow` by default) and read rules, as reads in the workspace do. Sibling repositories, notes, and docs are ordinary context for a coding agent; the risky places are the off-limits ones, and `privacy.localOnlyPaths` keeps a folder's content off remote models.
- **Edits outside the workspace ask.** `edit: allow`, a bare `edit` allow rule, a hook's allow, and `acceptEdits` don't skip the prompt. Editing there takes an allow rule whose path names the place. **Always** grants the file's folder as such a rule, not the whole category. On Windows, `//C:/...` names a drive path.
- **`permissions.outsideWorkspace: "deny"`** keeps file tools in the workspace. It's an ordinary key, so an organization can enforce it.
- **Switchback's own configuration** (`~/.switchback/` beyond the places above) asks on every edit, as the project's `.switchback/` already did.
- **Config edits are validated.** An edit or write to any Switchback config file (user, project, project-local) must still parse as JSONC and match the schema, checked by the same function `switchback init` uses before writing. A failing edit is reported to the model before the user is asked, and is never written.
- **Privacy follows.** `privacy.localOnlyPaths` uses the permission rules' path syntax and matcher, so folders outside the workspace (`~/customers/`) can be kept local.
- `bypassPermissions` still means no prompts: outside edits go ahead there, apart from the off-limits places and `outsideWorkspace: "deny"`.

`resolveInWorkspace` stays for places that must stay inside: `@file` mentions, checkpoints and rewind, review, and a skill's files.

## Consequences

- Asking the model to change your settings works, with a diff and a schema check.
- The gate is now the one place that keeps file tools in the workspace. Every file tool call passes through it (the tool runner and external runtimes both call it), and tests cover the outside cases.
- The prompt says why it asks (`reason` on `permission.requested`, additive), which also fixes prompts that called "running outside the OS sandbox" a rule.
- Allow rules don't widen the bash sandbox; `bash.sandbox.allowWrite` still does that.
- Windows paths in "always" rules (`//C:/...`) aren't covered by tests yet.
