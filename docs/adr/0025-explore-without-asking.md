# 0025: Read-only shell commands explore without asking

**Status:** Accepted · 2026-10-22

## Context

Models look around a project with the shell as much as with the read, glob, and grep tools: `ls`, `find`, `grep -rn`, `cd src && cat`, `git status`, `git diff`, `sed -n '1,40p'`. Those tools run without asking under `permissions.read: allow`, but the same reads through `bash` asked unless `switchback init` had written allow rules for them. A rule like `bash(find:*)` also allows `find -exec`, so the defaults needed ask rules for the flags that write, and each new flag was another hole to close.

## Decision

- The gate recognizes command lines that only explore (`permissions/explore.ts`): a fixed list of programs that read and print, read-only git subcommands, and `sed` scripts that only print. Every path they name, including option values and `cd` targets, must stay inside the workspace. Anything the parser can't vouch for (redirection, `$`, wrappers, writing flags, unknown programs) isn't exploring.
- An exploring command is decided by the `read` level instead of the `bash` level, after deny rules, ask rules, plan mode, and allow rules, so a user's rules still win.
- `read(...)` deny and ask rules are checked against the paths a command names. While any exists, recursive searches ask, because they can read a guarded file without naming it.
- `switchback init` no longer writes allow rules for these commands; it keeps the ask rules for publishing and rewriting history.
- bash output is checked for private files the way grep tool output is, so `grep -rn TOKEN .` pins a session local when it prints a line from a private path.

## Consequences

- Exploring doesn't prompt in any mode, including for users whose config predates this change.
- The list is an allow-list in code, so a read-only program that isn't on it still asks; adding one is a code change with a test.
- This is a policy check, not a sandbox: the bash sandbox still confines what the command can do if the parser is wrong.
- A command that reads a private file without naming or printing it isn't detected, as before ([privacy.md](../privacy.md)).
