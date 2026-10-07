# Permissions and safety

Switchback runs tools on the user's machine, so every tool call passes three checks: validation, workspace confinement, and the permission policy.

## 1. Validation

Tool inputs come from a model and are untrusted. Each tool has a Zod schema. Invalid input is never executed; the model receives the validation error instead, and the failure counts as a malformed-call signal for routing. Responses that stopped on `max_tokens` or `refusal` never have their tool calls executed, because the input may be truncated.

## 2. Workspace confinement

File tools resolve paths against the workspace root and reject anything outside it, including `..`, absolute paths elsewhere, and symlinks that point out of the workspace. The deepest existing ancestor is canonicalized with `realpath` before the check.

The `bash` tool runs with the workspace as its working directory, inside the OS sandbox where the platform has one (see [Sandbox](#sandbox)). It still defaults to `ask`: the sandbox limits what a command can reach, not what it does with what it can.

## 3. Permission policy

Every call that passes validation and confinement is decided in this order:

1. **A category set to `deny`** (`permissions.bash: "deny"`, or an MCP server's `permission: "deny"`). Nothing below overrides it, so an organization can turn a tool off.
2. **Deny rules.** The call is refused, and the model is told which rule refused it and where the rule came from.
3. **Plan mode.** Edits are refused until the user approves a plan.
4. **Bypass.** In `bypassPermissions`, everything else runs without a prompt.
5. **Ask rules,** a command that asks to run outside the sandbox, and edits to Switchback's own configuration (`.switchback/`): the user is asked, including in `acceptEdits`.
6. **Allow rules,** including what the user allowed earlier in the session.
7. **The mode.** `acceptEdits` allows edits.
8. **The category's level:** `allow`, or ask.

### Levels

| Category | Tools | Default |
|---|---|---|
| `read` | read, glob, grep | `allow` |
| `edit` | write, edit | `ask` |
| `bash` | bash | `ask` |
| `web` | webfetch, websearch | `ask` |
| `mcp` | tools from MCP servers (`mcp__<server>__<tool>`) | `ask`; a server's `permission` setting overrides it, except that a category-level `deny` always wins |
| (none) | task, exit_plan_mode, bash_output, kill_shell, todo | always allowed: a subagent's own tools are checked individually, and a background shell's command was checked when it started |

### Rules

A rule names a tool and optionally a specifier in parentheses:

```jsonc
"permissions": {
  "allow": ["bash(git status:*)", "bash(bun test:*)", "edit(src/**)"],
  "ask":   ["bash(git push:*)"],
  "deny":  ["read(.env)", "read(**/*.pem)", "bash(rm -rf:*)", "mcp__github__delete_repo"]
}
```

| Rule | Matches |
|---|---|
| `bash` | every command |
| `bash(npm run build)` | exactly that command |
| `bash(npm run test:*)` | that command, alone or followed by arguments |
| `bash(git * --force)` | `*` matches anything |
| `read(.env)` | read, glob, and grep of `.env` at any depth |
| `edit(src/**)` | edit and write under `src/` |
| `edit(/build/)` | under `build/` at the workspace root |
| `read(~/.ssh/**)`, `read(//etc/hosts)` | absolute paths: home directory, filesystem root |
| `webfetch(domain:docs.github.com)` | fetches from that host; `domain:*.github.com` covers its subdomains too |
| `websearch` | every web search |
| `mcp__github` or `mcp__github__*` | every tool of that server |
| `mcp__github__create_issue` | one tool |

Tool names are case-insensitive (`Bash` is `bash`); `glob` and `grep` are read rules and `write` is an edit rule. Path patterns are gitignore-style: a pattern without a slash matches that name at any depth, a trailing `/` means everything under the directory, and `**` crosses directories.

**Shell commands.** A command line can hold several commands (`a && b; c | d`). A deny or ask rule applies when any of them matches, and it also sees through `sudo`, `env`, `xargs`, `nice`, `nohup`, `time`, and `VAR=value` prefixes, so `bash(rm:*)` refuses `sudo rm -rf x`. An allow rule applies only when every command matches an allow rule, so `bash(git status:*)` never approves `git status; rm -rf x`. A command no rule can vouch for never matches an allow rule: one with command substitution (`$(...)`, backticks), process substitution (`<(...)`), or output redirected to a file. Those still ask. Rules are a policy aid, not a sandbox. A script can do whatever its interpreter can, so deny rules for `bash` are best effort; the [sandbox](#sandbox) is what holds.

**Searches.** A `read` deny rule also keeps matching files out of glob and grep results, so `read(.env)` hides `.env` from a search of the whole workspace.

**Where rules come from.** Rule lists add up across config layers instead of replacing each other: the user config, the project config, the project's personal file `.switchback/config.local.json`, and an organization's policy. A project can't remove a user's deny rules, and nobody can remove an organization's. `/permissions` (both clients) and `switchback doctor` list every rule in effect and where each came from.

### Answering a prompt

With `ask`, the engine emits `permission.requested` and waits. For `edit` and `write` the request includes a unified diff of the change, which both clients show. If building the preview shows the call would fail (for example `oldString` isn't in the file), the model gets that error and you aren't asked.

- **Allow once**: this call only.
- **Always this session**: allow rules for this call, shown in the prompt (`bash(git status:*)`, `edit`, `webfetch(domain:bun.sh)`, `mcp__github`), for the rest of the engine's lifetime.
- **Always in this project**: the same rules, also saved to `.switchback/config.local.json`. Switchback adds that file to `.switchback/.gitignore`, so your personal rules aren't committed.
- **Deny**: the model is told the call was declined and not to retry.

A call an ask rule caught offers no "always": the rule says to ask every time. Cancelling the turn denies any pending request. Headless `switchback run` denies `ask` permissions unless you pass `--yes`.

### Modes

| Mode | What it changes |
|---|---|
| `default` | Nothing: the levels and rules decide |
| `acceptEdits` | Edits in the workspace go ahead without asking; commands still ask |
| `plan` | No edits. The model reads, explores, and ends by presenting a plan with `exit_plan_mode`. **Approve** returns to `default`, **Approve and accept edits** switches to `acceptEdits`, and **Keep planning** stays in plan mode |
| `bypassPermissions` | Everything goes ahead without asking: ask rules, leaving the sandbox, and edits to `.switchback/` included. Only a category `deny`, a deny rule, and `bash.sandbox.allowUnsandboxed: false` stop a call |

New sessions start in `permissions.defaultMode`. Switch with Shift+Tab or `/mode` in the TUI, the **Mode** button above the VS Code chat input, `--permission-mode` on the command line, or `session.setMode` in the protocol. A session's subagents use its mode. The model hears about plan mode in a note added to your next prompt, never in the system prompt, so switching modes doesn't break the prompt cache.

An organization can turn off `bypassPermissions` (`restrictions.allowBypassPermissions: false`) and set everyone's permissions (`restrictions.allowUserPermissions: false`); see [organizations.md](organizations.md).

## Sandbox

Bash commands, foreground and background, run in an OS sandbox through Anthropic's [sandbox runtime](https://github.com/anthropics/sandbox-runtime): Seatbelt (`sandbox-exec`) on macOS, bubblewrap and seccomp on Linux. Inside it:

- **Writes** go only to the workspace (and a subagent's worktree), temp directories, package caches (`~/.npm`, `~/.bun/install/cache`, `~/.cache`, `~/.cargo/registry`, `~/go/pkg/mod`, `~/.gradle/caches`, `~/.m2/repository`, `~/Library/Caches`, ...), and `bash.sandbox.allowWrite`. Never to Switchback's own configuration (`.switchback/`) or to `.git/hooks` and `.git/config`, which would let a command run code outside the sandbox the next time you use git.
- **Reads** are open except credentials (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.azure`, `~/.kube`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.netrc`; set `bash.sandbox.denyRead` to change the list), Switchback's config and data directories, and files your `read(...)` deny rules name. `edit(...)` deny rules become write denies. So `read(.env)` holds for `cat .env` too.
- **Network** is open by default (`bash.sandbox.network: "all"`), so installs and `git fetch` work. Use a list of hosts (`["registry.npmjs.org", "*.github.com"]`) to allow only those, or `"none"`. Commands can listen on local ports (dev servers).

When the sandbox blocks something, the command's error says what was blocked, so the model can explain or find another way. If it needs to step outside, it can ask to run one command with `unsandboxed: true`; that asks you in every mode but `bypassPermissions`, and `bash.sandbox.allowUnsandboxed: false` refuses it.

`bash.sandbox.mode` is `auto` by default: on where the platform supports it, off with a one-time notice where it can't run. `on` refuses to run commands without it; `off` turns it off. `/permissions` and `switchback doctor` say whether it's on and, if not, why.

| Platform | Needs |
|---|---|
| macOS | `ripgrep` (`brew install ripgrep`) |
| Linux | `bubblewrap`, `socat`, and `ripgrep` (`apt-get install bubblewrap socat ripgrep`). On Ubuntu 24.04 and later, unprivileged user namespaces must be allowed (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or an AppArmor profile) |
| Windows | Not sandboxed. The runtime's Windows support is in alpha and needs an elevated install, so `auto` runs commands unsandboxed and `on` refuses to run them |

Known limits:

- Commands that push over SSH can't read `~/.ssh` in the default policy; use an HTTPS remote, take `~/.ssh` out of `denyRead`, or approve the one command unsandboxed.
- `git config` and anything else that writes `.git/config` fails inside the sandbox.
- On Linux, write paths are literal (no globs) and read-deny globs cover only the files that exist when the command starts.

An organization can enforce `bash.sandbox.mode: "on"` and `bash.sandbox.allowUnsandboxed: false` in its policy ([organizations.md](organizations.md)).

## Cost safety

Remote calls cost money, so they have their own guard rails:

- Budgets (`routing.budget`) keep automatic escalations local once a limit is reached.
- `escalation.policy: ask` requires approval before each escalation.
- Headless runs never approve an `ask` escalation.
- Every remote call appears in the UI with its reason and in the usage ledger with its cost.
