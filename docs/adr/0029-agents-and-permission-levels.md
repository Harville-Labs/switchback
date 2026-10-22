# 0029: Shift+Tab switches agents; permissions are a level of their own

**Status:** Accepted · 2026-10-22 · amends [0025](0025-auto-approve.md)

## Context

Shift+Tab cycles five permission modes: `default`, `acceptEdits`, `autoApprove`, `plan`, and `bypassPermissions`. They mix two things. `plan` is a way of working: read, think, propose, change nothing. The rest say how much to ask before a call runs. The footer shows the agent next to the mode (`build · auto-escalate`), but the agent can't change without starting a new session (`/agent <name>`), so a `plan` agent and a plan mode both exist and do almost the same thing.

OpenCode puts the way of working in the agent: Tab cycles primary agents (build, plan, and any the user defines), and each agent brings its own prompt, tools, and permissions. People who use both tools want that model here, with how much to ask set separately and less often.

Two invariants constrain how. The system prompt and tool list are frozen when a session is created (invariant 7), so changing agents can't rewrite them. And a project's files can't be allowed to loosen what the user set.

## Decision

**The session's agent can change.** `session.setAgent` switches a top-level session to another agent whose `mode` is `primary` or `all`; an `agent.changed` event tells every client. Shift+Tab cycles those agents in a fixed order: `build`, `plan`, then custom agents by name. `/agent <name>` switches the current session instead of starting a new one, and `--agent` picks the first. `explore`, `review`, and `general` stay subagent-only: they work for an agent, not for the user directly.

- **The prompt prefix doesn't move.** The system prompt keeps the agent the session started with. When the agent changes, the next prompt carries a reminder with the new agent's instructions and its tools, the way plan mode's note works today ([ADR 0017](0017-live-instructions.md)). Switching back to the first agent sends a short reminder too.
- **The tool list doesn't move.** A top-level session sends every tool it could use under any agent, in `ALL_TOOLS` order. The active agent's `tools` is enforced by the permission gate: a call outside it is refused, and the model hears which agent is active and that the user can switch. Subagents can't switch, so their tool lists stay filtered as now.
- A resumed session continues with the agent it last used, read from the session's files.

**Agents set permission defaults, and can only tighten them.** A new agent field, `permissions`, takes category levels (`read`, `edit`, `bash`, `web`, `mcp`) and `ask`/`deny` rules, applied on top of the config layers. An agent can turn `allow` into `ask` or `deny`, never the reverse, so an agent file in a cloned repository can't open up what the user's config closes. The built-in `plan` sets `edit: deny` and `bash: ask`.

**Plan mode becomes the `plan` agent.** It refuses edits through its `edit: deny`, and ends with `exit_plan_mode`, which works only for an agent that lists it in `tools`, so a custom planning agent can use it too. **Approve** switches the session back to the agent it was in before `plan` (the default agent if it started in `plan`). **Approve and auto-approve** does that and sets the permission level to `auto`. **Keep planning** stays.

**Permission level is one of three, set with `/permissions`.**

| Level | Was | Effect |
|---|---|---|
| `ask` | `default` | The levels and rules decide; anything that asks, asks you |
| `auto` | `autoApprove` | A model judges calls that would ask ([ADR 0025](0025-auto-approve.md)) |
| `bypass` | `bypassPermissions` | Everything runs except what deny rules and the always-off places stop |

- `/permissions` shows the level and the rules as now; `/permissions ask|auto|bypass` changes the level. VS Code replaces the **Mode** button with an agent dropdown and a permissions picker. `/mode` goes away.
- `acceptEdits` goes away. Its effect is `permissions.edit: "allow"` in config, which covers it without a third way to say the same thing.
- The protocol renames `PermissionMode` to `PermissionLevel` with the new values, `session.setMode` to `session.setPermissions`, and `mode.changed` to `permissions.changed`, and bumps `PROTOCOL_VERSION` to 3.
- Config keeps reading the old names: `permissions.defaultMode` becomes `permissions.level`; `default`, `autoApprove`, and `bypassPermissions` map to `ask`, `auto`, and `bypass`; `plan` maps to `ask` with `defaultAgent: plan`; `acceptEdits` maps to `ask` with a warning at startup and in `switchback doctor` that names `permissions.edit: "allow"`. Writing a config layer migrates the key. `--permission-mode` accepts old and new names.
- An organization's `allowBypassPermissions: false` rules out `bypass`, as before.
- ACP's session modes list the agents, since that is what an ACP client's mode menu means; the permission level stays a Switchback setting.

## Consequences

- Switching agents is instant and keeps the conversation, its cache, and its cost history. The model sees each switch as a note in the transcript.
- Sessions that start on a restricted agent send the full tool list, about as many tokens as a `build` session. A model under 32k context still gets the reduced list it gets today.
- The system prompt keeps the first agent's text. The reminder after a switch has to override it in words, which a weak local model may follow less well than a fresh system prompt. Starting a new session with `--agent` still gives the agent its own system prompt.
- Third-party clients on protocol 2 must rename the mode method, event, and values.
- Anyone who used `acceptEdits` gets prompts for edits again until they set `permissions.edit: "allow"`; the warning says so.
