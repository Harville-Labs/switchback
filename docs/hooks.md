# Hooks

Hooks run your own commands when something happens in a session: format a file after an edit, refuse a command, add the current branch to every prompt, tell you when Switchback is waiting. The format is Claude Code's, so hooks written for Claude Code work unchanged, and Switchback reads the `hooks` in a project's `.claude/settings.json` and `.claude/settings.local.json` too.

```jsonc
"hooks": {
  "PostToolUse": [
    { "matcher": "edit|write", "hooks": [{ "type": "command", "command": "bunx biome format --write \"$(jq -r .tool_input.path)\"" }] }
  ],
  "PreToolUse": [
    { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./scripts/check-command.sh", "timeout": 10 }] }
  ],
  "UserPromptSubmit": [
    { "hooks": [{ "type": "command", "command": "echo \"Current branch: $(git branch --show-current)\"" }] }
  ]
}
```

Each event lists matchers, and each matcher lists commands. Commands run in the workspace with the event as JSON on stdin, `SWITCHBACK_PROJECT_DIR` (and `CLAUDE_PROJECT_DIR`) set to the workspace, and a timeout in seconds (default 60). A matcher's commands run in parallel.

## Events

| Event | When | Matcher | What a hook can do |
|---|---|---|---|
| `PreToolUse` | Before a tool call, after its input is validated | Tool name, ours or Claude Code's (`bash`, `Bash`, `edit\|write`, `mcp__github__.*`) | Block it, allow it without asking, or make it ask |
| `PostToolUse` | After a tool call ran | Tool name | Tell the model something about the result (it already happened) |
| `UserPromptSubmit` | Before a prompt reaches the model, queued ones included | none | Block the prompt, or add context for the model |
| `Stop` | When the model finishes a turn | none | Send it back to work, with a reason (at most three times a turn) |
| `SubagentStop` | When a subagent finishes | none | The same, for the subagent |
| `SessionStart` | Before a session's first prompt in this engine | `startup` or `resume` | Add context for the model |
| `Notification` | When Switchback waits on you: a permission or escalation prompt | none | Anything (a desktop notification, a chat message); its answer is ignored |

Every event's JSON has `hook_event_name`, `session_id`, `cwd`, and `permission_mode`. Tool events add `tool_name` and `tool_input`, and `PostToolUse` adds `tool_response` (`output`, `isError`). `UserPromptSubmit` has `prompt`; `SessionStart` has `source`; `Stop` has `stop_hook_active` (true once a Stop hook already sent the model back); `Notification` has `message`.

## What a hook says back

- **Exit 0** carries on. Plain stdout is context for the model on `UserPromptSubmit` and `SessionStart` (added to the prompt as a note it sees and you don't).
- **Exit 2** blocks. Stderr says why: the model hears it for tool calls and Stop, and you see it for a blocked prompt.
- **Any other exit** is a warning in the log; nothing is blocked.

A hook can also print JSON, as in Claude Code:

| Field | Meaning |
|---|---|
| `hookSpecificOutput.permissionDecision` | `PreToolUse`: `allow`, `deny`, or `ask`, with `permissionDecisionReason` |
| `decision` | `block` (with `reason`) for any event that can block; `approve` means `allow` |
| `hookSpecificOutput.additionalContext` | Text for the model |
| `continue: false` | Stop here, with `stopReason` |
| `systemMessage` | A message shown to you |

When several hooks answer, a block from any of them wins, and deny beats ask beats allow.

**Hooks and permissions.** A `PreToolUse` hook's deny refuses the call. Its ask makes the call ask, whatever the mode. Its allow skips a prompt a [permission level](permissions.md) would show, but never a deny rule, an ask rule, a category set to `deny`, plan mode, or a command asking to leave the sandbox: those come first.

## Where hooks come from

Hooks add up across every config layer: your user config, the project's `.switchback/config.json` and `.switchback/config.local.json`, Claude Code's `.claude/settings.json` and `.claude/settings.local.json`, and an organization's policy. All of them run.

A project's hooks run commands from a checked-out repository, so they wait for your trust, like a project's MCP servers. `switchback hooks` lists the hooks in effect and the ones waiting; read them, then `switchback hooks trust`. Trust covers the exact definition, so a changed hook waits again. `switchback doctor` reports hooks waiting for trust.

An organization can run only its own hooks (`restrictions.allowUserHooks: false`); see [organizations.md](organizations.md).

## Differences from Claude Code

- Tool names match both ways: `bash` and `Bash`, `edit` and `Edit`.
- `transcript_path` isn't sent.
- Hooks run with your permissions, outside the bash tool's sandbox, as they do in Claude Code. Only trusted ones run.
- The `PreCompact` and `SessionEnd` events aren't supported yet.
