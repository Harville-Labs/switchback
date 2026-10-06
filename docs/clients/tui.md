# Terminal UI

`switchback` with no arguments opens the TUI in the current directory. It's built with [Ink](https://github.com/vadimdemedes/ink) and attaches to the workspace's shared engine daemon (starting it if needed), the same one VS Code uses, so sessions are shared live between them. `--no-daemon` runs a private in-process engine instead; `--mock` always does.

## First run

With no config file anywhere, `switchback` offers to run `switchback init` before opening the UI. Declining opens the UI anyway; turns run remotely until a local model is configured.

## Resuming

Sessions are saved as you go. `switchback --continue` (`-c`) reopens the most recent session in this workspace, and `switchback --session <id>` opens a specific one. Inside the TUI, `/sessions` lists them and `/resume <n>` switches. History is rebuilt from the transcript through the shared view model, so it looks the same as it did live (minus streamed reasoning).

## Screen

```
╭──────────────────────────────────────────────╮
│ ◆ Switchback v0.6.0                          │
│ ~/code/shop                                  │
│ / commands · @ mention a file · esc cancel   │
╰──────────────────────────────────────────────╯

❯ where is the retry logic?
☁ claude-opus-5 · context-overflow: ~29000 tokens exceeds 85% of local's 32768 window
● grep retry
● read src/http/foo.ts
  ⎿ src/http/foo.ts does not exist
↳ ✓ explore find retry logic · local · 6 tool calls

● Retries live in src/http/client.ts:88 ...
⠹ Running bash… (4s · esc to cancel)
╭──────────────────────────────────────────────────────────────────────────╮
│ ❯ Ask anything · / for commands · @ to mention a file                    │
╰──────────────────────────────────────────────────────────────────────────╯
 build · auto ☁ remote                    $0.0142 · today $0.31/$5.00 · week saved ~$4.12
```

- `⌂` lines are local routing decisions and `☁` lines are remote. Plain default decisions for the model already in use are hidden to reduce noise.
- `●` rows are tool calls, colored by state: yellow running, green succeeded, red failed, with the first line of a failure under it (`⎿`). Replies start with a white `●`.
- `↳` rows are subagents, showing their tier, tool-call count, and current activity. While one runs, its latest steps appear indented under the row (nested subagents too). Afterwards, `/subagents` lists them as a tree and `/subagent <n>` shows what one did: its routes, every tool call with the first line of output, nested subagents, and its final report.
- While a turn runs, a spinner line above the input says what's happening (thinking, running a tool, waiting on a subagent) and for how long.
- Typing `/` opens a command menu under the input, filtered as you type: ↑/↓ choose, Enter runs (or waits for the argument a command needs), Tab completes the name, Esc closes. It lists the same commands as `/help` and the VS Code chat; both come from `SLASH_COMMANDS` in `@switchback/client`.
- The status bar shows the agent, route preference, last tier used, session cost, today's spend against budget, and this week's savings.

## Commands and keys

| Input | Effect |
|---|---|
| `/local`, `/remote`, `/auto` | Route the following prompts |
| `/agent <name>` | New session with that agent |
| `/agents` | List agents and where they came from |
| `/new` | New session with the default agent |
| `/sessions` | Saved sessions in this workspace, newest first |
| `/resume [n\|id]` | Switch to a saved session. With no argument, a picker: type to filter by title, agent, or ID, ↑/↓ to choose, Enter to open. `switchback --resume` opens it at startup, `-c` resumes the latest, `--session <id>` a specific one, and `switchback sessions [--json]` lists them for scripts |
| `/subagents` | This session's subagents as a numbered tree |
| `/subagent <n>` | Drill into one subagent: routes, tool calls, nested subagents, and its report |
| `/shells` · `/shells kill <id>` | Background shells the model started (dev servers, watchers), and stopping one. The status bar counts the running ones |
| `/mcp` | MCP servers: connected, failed, or waiting for `switchback mcp trust`, with tool counts |
| `/compact` | Summarize earlier messages now. It also happens automatically as a session grows; the full history is kept |
| `/usage [rule\|agent\|model]` | The last 7 days: spend, budget, savings, cache hits, and a breakdown (by rule unless you pick another) |
| `/review on\|off\|default` | Review of edits for the next prompts ([review.md](../review.md)); `default` follows `review.mode` |
| `/review ladder` · `/review with <model...>` | Who reviews in this session: the escalation ladder, or models in order |
| `/models` | Every configured model, its tier, and the roles it fills |
| `/roles` · `/roles reset` | Which model does what in this session; `reset` follows your config again |
| `/start <model...>` | Where turns start (more models are backups for when it's down or too small) |
| `/escalate <step...>` · `/escalate none` | The escalation ladder; a step is a model, or `a,b` alternatives |
| `/subagent-model <model>\|none` | Default model for subagents |
| `/mode [default\|accept-edits\|plan\|bypass]` | Show or switch the permission mode ([permissions.md](../permissions.md#modes)) |
| `/permissions` | The mode, the permission levels, and every rule with where it came from |

| `/copy [n\|tool\|all]` | Copy to the clipboard as raw text (no wrapping, indentation, or colors from the terminal rendering): the last reply, its `n`th code block, the last tool's output, or the whole conversation as Markdown. Works over SSH in terminals that support OSC 52 (iTerm2, kitty, WezTerm, Ghostty, Windows Terminal, and tmux with `set-clipboard on`) |
| `/receipt` | This session and its subagents: what it cost against running it all on the reference remote model |
| `/help`, `/exit` | |
| `@path` | Mention a file; a menu completes paths (Tab or Enter to insert). The file's contents are attached to the prompt. |
| `↑` / `↓` | Move between lines, then browse this workspace's prompt history |
| Option/Alt+Enter, Ctrl+J, or `\` then Enter | Newline |
| Paste | Arrives whole (bracketed paste), so newlines in it never send the prompt. Terminal colors and control characters are removed. A paste of 12 lines or 1,500 characters or more shows as a chip, `[Pasted text #1 · 240 lines]`, that Backspace deletes in one go and that expands to the full text when you send. A file dragged into the terminal becomes an `@` mention when it's in the workspace |
| Ctrl+A / Ctrl+E, Ctrl+U, Ctrl+W | Line start / end, delete to line start, delete word |
| `esc` | Cancel the running turn (or close the mention menu) |
| Shift+Tab | Cycle the permission mode: default → accept edits → plan (→ bypass, unless your organization turns it off) |
| `y` / `a` / `p` / `n` | Answer a permission prompt: once, always this session (the rules it grants are shown), always in this project (saved to `.switchback/config.local.json`), deny |
| `y` / `a` / `n` | Answer a plan: approve, approve and accept edits, keep planning |
| `y` / `n` | Answer an escalation prompt |
| `ctrl+c` | With text in the prompt (a paste chip included), clear it. With an empty prompt, cancel the running turn; when idle, press it twice within 2 seconds to quit. In a permission or escalation prompt, it answers no |

Role commands change the current session; add `--save` to make the change your default (written to the user config). Keys an organization enforces can't be changed. The status line shows where the session is on the ladder (`step 1/2 qwen3-coder-480b, 2 more`) and the permission mode when it isn't `default`.

## Implementation notes

- Finished items render through Ink's `<Static>`, so long sessions don't re-render history. Assistant text is plain while it streams and is rendered as Markdown (with syntax-highlighted code) once the turn finishes, so half-written Markdown never flickers.
- All display state comes from `reduce()` in `@switchback/client/view`. If something looks wrong in both clients, fix it there.
