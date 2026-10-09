# Editors on ACP: `switchback acp`

`switchback acp` runs Switchback as an agent for any editor that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP): Zed, JetBrains IDEs, and Neovim and Emacs plugins among them. The editor starts it and talks to it over stdin and stdout.

Point your editor's agent settings at the command. In Zed's `settings.json`:

```jsonc
{
  "agent_servers": {
    "Switchback": { "command": "switchback", "args": ["acp"] }
  }
}
```

Other editors take the same command and arguments; see their docs for where. Run `switchback init` first, as for the terminal UI.

## How it works

The ACP agent is a client of the engine, like the terminal UI. Each workspace the editor opens attaches to that workspace's [shared engine](../architecture.md#the-shared-daemon) (starting it if needed), so a session started in your editor shows up live in the TUI and VS Code, and `switchback --session <id>` resumes it. `--no-daemon` or `SWITCHBACK_NO_DAEMON=1` runs a private engine instead; `--mock` always does.

| In the editor | In Switchback |
|---|---|
| A new thread | A new session, with your config, agents, `AGENTS.md`, and permission rules |
| The thread's mode | The [permission mode](../permissions.md#modes): Default, Accept edits, Plan, or Bypass permissions |
| Messages and thinking | The model's answer and reasoning, as they stream |
| A line of thinking such as `→ remote anthropic/claude-sonnet-5: …` | A routing decision: which model answers from here and why. It's shown whenever the model changes |
| Tool calls | Tool calls, titled as in the TUI (`Read src/app.ts`, `Bash bun test`). Edits show their diff |
| Permission prompts | Permission prompts. **Always allow** is the TUI's **Always this session**: it grants the rule for as long as the engine runs. To save a rule, answer in the TUI or VS Code, or edit your config. A plan in plan mode can be approved, approved with edits accepted from then on, or sent back |
| A cost prompt such as "Escalate to …" | An [escalation](../routing.md) that needs your approval, with its estimated cost |
| The plan | The `todo` checklist |
| Past threads | Saved sessions in the workspace, which load with their conversation |
| `@`-mentioned files and selections | Attachments: files in the workspace by path (so [privacy](../privacy.md) and deny rules apply), other context as text, and images |

## Limits

- MCP servers the editor offers are ignored. Switchback uses the servers in its own [config](../configuration.md#mcpserversname), so every client sees the same tools.
- Switchback reads and writes files on disk itself, and runs commands in its own [sandbox](../permissions.md#sandbox). It doesn't see edits you haven't saved, and commands don't run in the editor's terminal.
- A subagent's steps stay inside its `task` tool call; only its permission prompts reach the editor.
