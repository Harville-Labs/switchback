# Terminal UI

`switchback` with no arguments opens the TUI in the current directory. It's built with [Ink](https://github.com/vadimdemedes/ink) and attaches to the workspace's shared engine daemon (starting it if needed), the same one VS Code uses, so sessions are shared live between them. `--no-daemon` runs a private in-process engine instead; `--mock` always does.

## First run

With no config file anywhere, `switchback` starts setup (`switchback init`) before opening the UI, beginning with "Do you have any local model endpoints?" Answering no to that and to remote providers writes nothing and opens the UI anyway; run `switchback init` later to add models.

## Resuming

Sessions are saved as you go. `switchback --continue` (`-c`) reopens the most recent session in this workspace, and `switchback --session <id>` opens a specific one. Inside the TUI, `/sessions` lists them and `/resume <n>` switches. History is rebuilt from the transcript through the shared view model, so it looks the same as it did live (minus streamed reasoning).

## Screen

The TUI takes over the whole terminal, like an editor: the transcript fills the window and the input stays at the bottom. Quitting puts your shell back as it was and prints how to resume the session.

```
╭──────────────────────────────────────────────────────╮
│ ◆ Switchback v1.0.0                                  │
│                                                      │
│ model         qwen3-coder (local)                    │
│ escalates to  claude-opus-5 (remote)                 │
│ mode          default                                │
│ directory     ~/code/shop                            │
╰──────────────────────────────────────────────────────╯
  / commands · @ files · shift+tab mode · ctrl+o expand · PgUp/PgDn scroll

› where is the retry logic?

● Explored · read 2 files · 1 search
  ⎿  Search "retry" · 7 matches in 3 files
     Read src/http/client.ts · 212 lines
     Read src/http/backoff.ts · 40 lines

● Update src/http/backoff.ts
  ⎿  2 additions, 1 removal
       12   const base = 250;
       13 -   return base * attempt;
       13 +   const jitter = Math.random() * base;
       14 +   return base * 2 ** attempt + jitter;

● Bash bun test src/http
  ⎿  ✓ 18 tests passed
     … +3 lines (ctrl+o to expand)

● Backoff is exponential now, with jitter ...

⠹ Running… (12s · ↓ 1.4k tokens · ⌂ qwen3-coder · esc to interrupt)
╭──────────────────────────────────────────────────────────────────────────╮
│ ❯ Ask anything · / for commands · @ to mention a file                    │
╰──────────────────────────────────────────────────────────────────────────╯
 build · auto                                  82% context left · $0.014 · 52 tok/s
```

- **The welcome card** names the model turns start on, what they escalate to, the permission mode, and the directory.
- **Tool calls** are `●` rows: what the call does and to what (`Read src/x.ts`, `Bash bun test`, `Update a.ts`), with what came of it under `⎿`: lines read, files listed, matches found, the first lines a command printed (and its exit code when it failed), or an edit's size and diff with line numbers. The dot is yellow while it runs, green when it worked, red when it failed.
- **Exploring** — two or more reads, listings, and searches in a row — folds into one **Explored** block listing each call and what it found.
- **Routing** shows a `⌂` (local) or `☁` (remote) line only when the model changes, with the reason; the welcome card covers where turns start.
- **Subagents** are rows of their own, with their tier, tool-call count, and current activity, and their latest steps indented under them while they run. Afterwards, `/subagents` lists them as a tree and `/subagent <n>` shows what one did.
- **While a turn runs**, a line above the input says what's happening (thinking, writing, running a tool, waiting on a subagent), for how long, about how many tokens the model has written, and on which model.
- **The status bar** shows the permission mode as a badge when it isn't `default`, the agent and route preference, how much of the model's context is left (in yellow below 15%), the session's cost once there is one, today's spend when you've set a daily budget, savings, and the last call's speed.
- Typing `/` opens a command menu under the input, filtered as you type: ↑/↓ choose, Enter runs (or waits for the argument a command needs), Tab completes the name, Esc closes. It lists the same commands as `/help` and the VS Code chat; both come from `SLASH_COMMANDS` in `@switchback/client`. Your [custom commands](../commands-and-skills.md) follow under **Custom**.

### Scrolling and selecting

Page Up and Page Down scroll the transcript, and so does the mouse wheel. Scrolled up, a bar says how far, and new output collects below without moving what you're reading; Page Down to the end follows the conversation again, and sending a prompt jumps there.

The TUI turns on the terminal's mouse reporting for the wheel, which also captures clicks, so selecting text takes a modifier while you drag: Shift in most terminals, Option in macOS Terminal and iTerm2. `/copy` copies replies, code blocks, and tool output without selecting anything.

### Themes

`/theme dark`, `/theme light`, or `/theme plain` (no color at all) switches the colors and remembers the choice for next time.

### Prompts

Permission, plan, and escalation prompts list their choices: ↑/↓ and Enter, or the option's number; the letters from before (`y`, `a`, `p`, `n`) still work, and Esc declines. A permission prompt shows the command, or the edit as a diff, and offers **No, and tell it what to do instead**: type a note and press Enter, and the model gets it with the refusal.

## Commands and keys

| Input | Effect |
|---|---|
| `/local`, `/remote`, `/auto` | Route the following prompts |
| `/up` (alt+↑) | Escalate: the turn's next step, or your next prompt, goes one step up the ladder ([routing.md](../routing.md#escalating-yourself)). On macOS Terminal, alt needs "Use Option as Meta key"; `/up` always works |
| `/agent <name>` | New session with that agent |
| `/agents` | List agents and where they came from |
| `/new` | New session with the default agent |
| `/sessions` | Saved sessions in this workspace, newest first |
| `/resume [n\|id]` | Switch to a saved session. With no argument, a picker: type to filter by title, agent, or ID, ↑/↓ to choose, Enter to open. `switchback --resume` opens it at startup, `-c` resumes the latest, `--session <id>` a specific one, and `switchback sessions [--json]` lists them for scripts |
| `/subagents` | This session's subagents as a numbered tree |
| `/subagent <n>` | Drill into one subagent: routes, tool calls, nested subagents, and its report |
| `/shells` · `/shells kill <id>` | Background shells the model started (dev servers, watchers), and stopping one. The status bar counts the running ones |
| `/mcp` | MCP servers: connected, failed, or waiting for `switchback mcp trust`, with tool counts |
| `/worktrees` · `/worktrees <branch>` | Branches isolated subagents made (running, ready to merge, merged, or kept), or one branch's diff ([subagents.md](../subagents.md#seeing-what-they-did)) |
| `/rewind` | Go back to before a prompt: pick it, then `b` (files and conversation), `f` (files only), or `c` (conversation only). Files changed since then by edit or write go back and files created since are removed; changes made by shell commands aren't tracked. The conversation continues in a new session, and this one is kept |
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
| `/theme [dark\|light\|plain]` | Show or switch the colors; the choice is remembered |
| `/help`, `/exit` | |
| `@path` | Mention a file; a menu completes paths (Tab or Enter to insert). The file's contents are attached to the prompt. |
| `↑` / `↓` | Move between lines, then browse this workspace's prompt history |
| Option/Alt+Enter, Ctrl+J, or `\` then Enter | Newline |
| Paste | Arrives whole (bracketed paste), so newlines in it never send the prompt. Terminal colors and control characters are removed. A paste of 12 lines or 1,500 characters or more shows as a chip, `[Pasted text #1 · 240 lines]`, that Backspace deletes in one go and that expands to the full text when you send. A file dragged into the terminal becomes an `@` mention when it's in the workspace |
| Ctrl+A / Ctrl+E, Ctrl+U, Ctrl+W | Line start / end, delete to line start, delete word |
| Enter during a turn | Queue the message: the model reads it at its next step (between tool calls), or as the next turn if it's already finishing. Queued messages show under the transcript |
| `esc` | During a turn, with a message typed: stop the turn and send it now. With an empty prompt: cancel the turn and drop the queue. Otherwise it closes a menu |
| `↑` on an empty prompt | Take back the last queued message to edit it |
| Shift+Tab | Cycle the permission mode: default → accept edits → plan (→ bypass, unless your organization turns it off) |
| ↑/↓ and Enter, or `1`–`5` | Answer a permission, plan, or escalation prompt. Permission: yes; yes and don't ask again this session (the rules it grants are shown); yes and always in this project (saved to `.switchback/config.local.json`); no; no, and tell it what to do instead |
| `y` / `a` / `p` / `n` | The same answers by letter: once, always this session, always in this project, deny (plans: approve, approve and accept edits, keep planning) |
| Page Up / Page Down, mouse wheel | Scroll the transcript |
| `ctrl+v` | Attach the image on the clipboard as an `[Image #n]` chip (deleting the chip drops it). On macOS it reads the clipboard with `osascript`, on Linux with `wl-paste` or `xclip`, and on Windows with PowerShell; over SSH, drag the file in or mention it with `@` instead. Dragged-in image files and `@image.png` mentions attach the image too |
| `ctrl+o` | Expand or collapse the details: the model's thinking (one line, or its paragraphs), commands' full output, whole diffs, and every call in an Explored block. It applies to the whole transcript |
| `ctrl+c` | With text in the prompt (a paste chip included), clear it. With an empty prompt, cancel the running turn; when idle, press it twice within 2 seconds to quit. In a permission or escalation prompt, it answers no |

When a prompt is waiting for you, or a turn that ran 30 seconds or more finishes, the TUI asks the terminal for a desktop notification, or rings the bell where it can't (`notifications` in [configuration.md](../configuration.md#notifications)).

Role commands change the current session; add `--save` to make the change your default (written to the user config). Keys an organization enforces can't be changed. The status line shows where the session is on the ladder (`step 1/2 qwen3-coder-480b, 2 more`) and the permission mode when it isn't `default`.

## Implementation notes

- The TUI runs in the terminal's alternate screen (Ink's `alternateScreen`). Each transcript row is rendered to lines once (`renderToString`) and cached by the identity of its items, which the view reducer replaces only when they change, so a long session costs what's on screen. The viewport is a window onto those lines.
- Ink reads keys from a stand-in for stdin that takes the wheel's mouse sequences out first (`tui/mouse.ts`), so they never reach the prompt as text.
- Assistant text is plain while it streams and is rendered as Markdown (with syntax-highlighted code) once the turn finishes, so half-written Markdown never flickers.
- Colors come from roles in `tui/theme.ts` (brand, local, remote, added, removed, ...), never from color names in components.
- All display state comes from `reduce()` in `@switchback/client/view`, and what a tool call says about itself from `@switchback/client/tool-display`. If something looks wrong in both clients, fix it there.
