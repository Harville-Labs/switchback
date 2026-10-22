# Terminal UI

`switchback` with no arguments opens the TUI in the current directory. It's built with [Ink](https://github.com/vadimdemedes/ink) and attaches to the workspace's shared engine daemon (starting it if needed), the same one VS Code uses, so sessions are shared live between them. `--no-daemon` runs a private in-process engine instead; `--mock` always does.

## First run

With no config file anywhere, `switchback` opens with setup's first question in a panel above the prompt, as `/init` and `switchback init` do. Answering no throughout, or Esc, writes nothing and leaves the TUI open; run `/init` later to add models. After setup writes a config, the panel asks the questions about this machine: the command sandbox on Windows, and telemetry if you haven't chosen.

## Updates

When a newer release is out, the TUI says so in the chat at launch: `Switchback 2.2.0 is out (you have 2.1.0). Update with switchback update.` It asks GitHub at most once a day and never waits on a slow answer. `updates.check: false` in [config](../configuration.md#updates) turns it off.

## Resuming

Sessions are saved as you go. `switchback --continue` (`-c`) reopens the most recent session in this workspace, and `switchback --session <id>` opens a specific one. Inside the TUI, `/sessions` lists them and `/resume <n>` switches. History is rebuilt from the transcript through the shared view model, so it looks the same as it did live (minus streamed reasoning).

The terminal's window or tab title shows the session's title (`Fix the login bug · Switchback`) and follows the tab in front. On exit Switchback restores the title you had before, in terminals that keep a title stack (xterm, iTerm2, kitty, WezTerm, VS Code's terminal); others keep the last title.

## Screen

The TUI takes over the whole terminal, like an editor: the transcript fills the window and the input stays at the bottom. Quitting puts your shell back as it was and prints how to resume the session.

```
╭──────────────────────────────────────────────────────╮
│ ◆ Switchback v1.0.0                                  │
│                                                      │
│ current       qwen3-coder (local)                    │
│ escalates to  claude-opus-5 (remote)                 │
│ mode          default                                │
│ directory     ~/code/shop                            │
╰──────────────────────────────────────────────────────╯
  / commands · @ files · tab model · alt+↓ subagents · shift+tab mode · ctrl+o expand · PgUp/PgDn scroll

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
 build · auto · ⌂ qwen3-coder     82% context left · $0.014 · cache 91% · 52 tok/s
```

- **The welcome card** names the current model (where your prompts run), what it escalates to, the permission mode, and the directory. The status bar names the current model too, until an escalation moves the session up the ladder. `/current` picks another ([routing.md](../routing.md#picking-the-current-model)).
- **Tool calls** are `●` rows: what the call does and to what (`Read src/x.ts`, `Bash bun test`, `Update a.ts`), with what came of it under `⎿`: lines read, files listed, matches found, the first lines a command printed (and its exit code when it failed), or an edit's size and diff with line numbers. The dot is yellow while it runs, green when it worked, red when it failed.
- **Exploring** — two or more reads, listings, and searches in a row — folds into one **Explored** block listing each call and what it found.
- **Routing** shows a `⌂` (local) or `▲` (remote) line only when the model changes, with the reason; the welcome card covers the current model.
- **Subagents** are rows of their own, with their tier, tool-call count, and current activity, and their latest steps indented under them while they run. Afterwards, `/subagents` lists them as a tree and `/subagent <n>` shows what one did.
- **While a turn runs**, a line above the input says what's happening (thinking, writing, running a tool, waiting on a subagent), for how long, about how many tokens the model has written, and on which model.
- **The status bar** shows the permission mode as a badge when it isn't `default`, the agent and route preference, how much of the model's context is left (in yellow below 15%), the session's cost once there is one, today's spend when you've set a daily budget, savings, the prompt-cache hit rate, and the last call's speed. The hit rate is cached input tokens over all input tokens for the session's calls (`cache 91%`), with the latest turn's after it when that differs (`cache 91% · turn 98%`). It counts remote calls, and local ones whose server reports caching; a rate that drops on a long remote session means something is changing the prompt prefix ([routing.md](../routing.md#prompt-caching-and-stickiness)).
- Typing `/` opens a command menu under the input, filtered as you type: ↑/↓ choose, Enter runs (or waits for the argument a command needs), Tab completes the name, Esc closes. It lists the same commands as `/help` and the VS Code chat; both come from `SLASH_COMMANDS` in `@switchback/client`. Your [custom commands](../commands-and-skills.md) follow under **Custom**.

### Tabs

Several sessions can be open at once, each in its own tab, and they all keep working: a turn in a tab you're not looking at runs to the end, and a permission or escalation prompt waits in its tab until you go there. With more than one tab open, a line above the transcript lists them by number, with a mark for what each needs: `?` waiting for you, `●` working, `✓` finished since you last looked, `✗` stopped with an error.

```
 ? 1 fix retry logic  │ ● 2 docs pass  │  3 new session   click a tab · ctrl+t all
```

- **Ctrl+T** opens the sessions dashboard: every open tab with what it's doing (`Bash bun test`, `Writing`, `Waiting on explore`), on which model, and what it has cost, then the sessions working or waiting in other windows on the same engine (another terminal, VS Code). ↑/↓ and Enter switch, a tab's number jumps to it, `n` opens a new tab, `x` closes the selected one, Esc goes back. Choosing a session from another window opens it here in a new tab, live.
- **Ctrl+Tab** and **Ctrl+Shift+Tab** move to the next or previous tab, **Alt+1…9** jumps to a tab, **Alt+←/→** moves too, and a click on a tab brings it forward. They work while a prompt is waiting, so you can leave it and come back. Switchback turns on kitty's keyboard protocol in terminals that support it (kitty, Ghostty, foot, iTerm2, and WezTerm with `enable_kitty_keyboard`), so Ctrl+Tab and Shift+Enter arrive as themselves. A terminal's own shortcuts still come first: kitty, Ghostty, WezTerm, iTerm2, and Terminal.app use Ctrl+Tab to switch their own tabs, so it reaches Switchback only once you unbind it there. A click on a tab and Ctrl+T work in every terminal.

  To give Ctrl+Tab and Ctrl+Shift+Tab to Switchback, copy the lines for your terminal: [kitty](../../examples/terminals/kitty.conf), [Ghostty](../../examples/terminals/ghostty.conf), [WezTerm](../../examples/terminals/wezterm.lua), or [iTerm2](../../examples/terminals/iterm2.md) (a few clicks in its settings). Terminal.app can't unbind it.
- **Ctrl+W** on an empty prompt closes the tab in front; with text typed, it deletes a word.
- `/tab new [agent]` opens a tab, `/tab <n>` switches, `/tab close` closes the one in front, and `/tab` alone prints the dashboard.
- Closing a tab doesn't stop its session: a running turn finishes in the background and stays on the dashboard until it's done. `/new`, `/agent`, and `/resume` change the session in the tab in front, as before; `/resume` of a session that's open in another tab switches to it.

Tabs are the clients' own; the engine sends every session's events to every client, and both clients fold them with the same functions (`@switchback/client/tabs`), so the TUI and VS Code show the same states with the same words ([protocol.md](../protocol.md#several-sessions-at-once)).

### Subagents

While subagents run, **Alt+↓** shows the next one in place of the session: its header names the agent and its task, the status bar says `↳ viewing explore (alt+↑ back)`, and the transcript is the subagent's own. **Alt+↑** comes back to the session, as does Alt+↓ after the last one. There, `/model` picks the model for subagents started from then on; in the session's own view, `/model` is `/current`. Prompts always go to the session, and sending one brings it back into view.

### Scrolling and selecting

Page Up and Page Down scroll the transcript, and so does the mouse wheel. Scrolled up, a bar says how far, and new output collects below without moving what you're reading; Page Down to the end follows the conversation again, and sending a prompt jumps there.

On macOS and Linux the TUI turns on the terminal's mouse reporting for the wheel and tab clicks, which also captures clicks, so selecting text takes a modifier while you drag: Shift in most terminals, Option in macOS Terminal and iTerm2.

On Windows mouse reporting starts off, so dragging selects text as in any other console program and Ctrl+C or Enter copies it (Windows Terminal, conhost, and VS Code's terminal). The wheel doesn't scroll the transcript then; Page Up and Page Down do. `/mouse on` turns reporting on (Shift+drag then selects in Windows Terminal and VS Code), `/mouse off` turns it off on any platform, and the choice is remembered.

`/copy` copies replies, code blocks, and tool output without selecting anything.

### Themes

`/theme dark`, `/theme light`, or `/theme plain` (no color at all) switches the colors and remembers the choice for next time.

### Prompts

Permission, plan, and escalation prompts list their choices: ↑/↓ and Enter, or the option's number; the letters from before (`y`, `a`, `p`, `n`) still work, and Esc declines. A permission prompt shows the command, or the edit as a diff, and offers **No, and tell it what to do instead**: type a note and press Enter, and the model gets it with the refusal.

## Commands and keys

| Input | Effect |
|---|---|
| `/local`, `/remote`, `/auto` | Route the following prompts |
| `/up` | Escalate: the turn's next step, or your next prompt, goes one step up the ladder ([routing.md](../routing.md#escalating-yourself)) |
| `/agent <name>` | New session with that agent |
| `/agents` | List agents and where they came from |
| `/new` | New session with the default agent, in the tab in front |
| `/tabs` (ctrl+t) | The sessions dashboard: open tabs, then sessions working in other windows ([Tabs](#tabs)) |
| `/tab [n\|new [agent]\|close]` | Switch to tab `n`, open a new tab, or close the one in front (its session keeps running) |
| `/sessions` | Saved sessions in this workspace, newest first |
| `/resume [n\|id]` | Switch to a saved session. With no argument, a picker: type to filter by title, agent, or ID, ↑/↓ to choose, Enter to open. `switchback --resume` opens it at startup, `-c` resumes the latest, `--session <id>` a specific one, and `switchback sessions [--json]` lists them for scripts |
| `/rename [title]` | Name this session (at most 60 characters). With no argument, shows the current title. A session is titled from its first prompt until you rename it, and a summary at compaction can retitle it, but never over a name you gave |
| `/subagents` | This session's subagents as a numbered tree |
| `/subagent <n>` | Drill into one subagent: routes, tool calls, nested subagents, and its report |
| `/shells` · `/shells kill <id>` | Background shells the model started (dev servers, watchers), and stopping one. The status bar counts the running ones |
| `/reload` | Read the config files again and apply them, saying which settings changed. Config files aren't watched, so edits made outside Switchback wait for this or the next engine ([configuration.md](../configuration.md)) |
| `/mcp` | MCP servers: connected, failed, or waiting for `switchback mcp trust`, with tool counts |
| `/worktrees` · `/worktrees <branch>` | Branches isolated subagents made (running, ready to merge, merged, or kept), or one branch's diff ([subagents.md](../subagents.md#seeing-what-they-did)) |
| `/rewind` | Go back to before a prompt: pick it, then `b` (files and conversation), `f` (files only), or `c` (conversation only). Files changed since then by edit or write go back and files created since are removed; changes made by shell commands aren't tracked. The conversation continues in a new session, and this one is kept |
| `/goal <objective>` · `/goal` · `/goal stop` | Keep working toward an objective across turns until the model says it's done or blocked ([Goals](#goals)). Bare `/goal` shows progress; `/goal stop` ends it after the running turn, and Esc ends it now |
| `/compact` | Summarize earlier messages now. It also happens automatically as a session grows; the full history is kept |
| `/usage [rule\|agent\|model]` | The last 7 days: spend, budget, savings, cache hits, and a breakdown (by rule unless you pick another) |
| `/review on\|off\|default` | Review of edits for the next prompts ([review.md](../review.md)); `default` follows `review.mode` |
| `/review ladder` · `/review with <model...>` | Who reviews in this session: the escalation ladder, or models in order |
| `/models [refresh]` | Every configured model, its tier, and the roles it fills. `refresh` asks each endpoint and subscription what it serves now and adds the new models, without running setup again |
| `/init` | Run setup inside the TUI: the same questions as `switchback init` (local servers and their models, remote providers, which model does what), asked in a panel above the prompt. ↑/↓ and Enter answer, space ticks in a checklist, typing filters a long list, Esc cancels without writing anything. The new config is in use as soon as it's saved |
| `/roles` · `/roles reset` | Which model does what in this session; `reset` follows your config again |
| `/current [model...]` | The current model, where your prompts run. With no argument, a picker: ↑/↓ and Enter, or its number; the models that were current stay as backups. With models, the first is current and the rest are backups for when it's down or too small. `/start` still works |
| `/model [model]` | The model for what's in front: `/current` in the session's view, the subagent model in a subagent's ([Subagents](#subagents)) |
| `/escalate <step...>` · `/escalate none` | The escalation ladder; a step is a model, or `a,b` alternatives |
| `/subagent-model <model>\|none` | Default model for subagents |
| `/effort [none\|low\|medium\|high\|xhigh\|max\|default]` | Show or set reasoning effort for this session's own model calls (`switchback --effort` at startup). Subagents keep theirs; `default` goes back to the agent's or model's ([subagents.md](../subagents.md#reasoning-effort)) |
| `/mode [default\|accept-edits\|plan\|bypass]` | Show or switch the permission mode ([permissions.md](../permissions.md#modes)) |
| `/permissions` | The mode, the permission levels, and every rule with where it came from |

| `/copy [n\|tool\|all]` | Copy to the clipboard as raw text (no wrapping, indentation, or colors from the terminal rendering): the last reply, its `n`th code block, the last tool's output, or the whole conversation as Markdown. Works over SSH in terminals that support OSC 52 (iTerm2, kitty, WezTerm, Ghostty, Windows Terminal, and tmux with `set-clipboard on`) |
| `/receipt` | This session and its subagents: what it cost against running it all on the reference remote model |
| `/theme [dark\|light\|plain]` | Show or switch the colors; the choice is remembered |
| `/mouse [on\|off]` | Mouse reporting: on, the wheel scrolls and clicks pick tabs; off, a plain drag selects text. Off by default on Windows, on elsewhere; with no argument it switches, and the choice is remembered ([Scrolling and selecting](#scrolling-and-selecting)) |
| `/help`, `/exit` | |
| `@path` | Mention a file; a menu completes paths (Tab or Enter to insert). The file's contents are attached to the prompt. |
| `↑` / `↓` | Move between lines, then browse this workspace's prompt history |
| Option/Alt+Enter, Ctrl+J, or `\` then Enter | Newline |
| Paste | Arrives whole (bracketed paste), so newlines in it never send the prompt. Terminal colors and control characters are removed. A paste of 12 lines or 1,500 characters or more shows as a chip, `[Pasted text #1 · 240 lines]`, that Backspace deletes in one go and that expands to the full text when you send. A file dragged into the terminal becomes an `@` mention when it's in the workspace |
| Ctrl+A / Ctrl+E, Ctrl+U, Ctrl+W | Line start / end, delete to line start, delete word (on an empty prompt, Ctrl+W closes the tab) |
| Enter during a turn | Queue the message: the model reads it at its next step (between tool calls), or as the next turn if it's already finishing. Queued messages show under the transcript |
| `esc` | During a turn, with a message typed: stop the turn and send it now. With an empty prompt: cancel the turn and drop the queue. Otherwise it closes a menu |
| `↑` on an empty prompt | Take back the last queued message to edit it |
| Ctrl+T | The sessions dashboard ([Tabs](#tabs)) |
| Ctrl+Tab / Ctrl+Shift+Tab, Alt+1…9, Alt+←/→, click | Next or previous tab, tab n, or the tab clicked ([Tabs](#tabs)) |
| Alt+↓ / Alt+↑ | Show the next running subagent / come back to the session ([Subagents](#subagents)). On macOS Terminal, alt needs "Use Option as Meta key" |
| Tab (no menu open) | Switch to the next model: the one after the current model in config order, back to the first after the last. It says `Switched to <model>.` and applies to this session; the model you leave doesn't stay behind as a backup |
| Shift+Tab | Cycle the permission mode: default → accept edits → plan (→ bypass, unless your organization turns it off) |
| ↑/↓ and Enter, or `1`–`5` | Answer a permission, plan, or escalation prompt. Permission: yes; yes and don't ask again this session (the rules it grants are shown); yes and always in this project (saved to `.switchback/config.local.json`); no; no, and tell it what to do instead |
| `y` / `a` / `p` / `n` | The same answers by letter: once, always this session, always in this project, deny (plans: approve, approve and accept edits, keep planning) |
| Page Up / Page Down, mouse wheel | Scroll the transcript (the wheel only while `/mouse` is on) |
| `ctrl+v` | Attach the image on the clipboard as an `[Image #n]` chip (deleting the chip drops it). On macOS it reads the clipboard with `osascript`, on Linux with `wl-paste` or `xclip`, and on Windows with PowerShell; over SSH, drag the file in or mention it with `@` instead. Dragged-in image files and `@image.png` mentions attach the image too |
| `ctrl+o` | Expand or collapse the details: the model's thinking (one line, or its paragraphs), commands' full output, whole diffs, and every call in an Explored block. It applies to the whole transcript |
| `ctrl+c` | With text in the prompt (a paste chip included), clear it. With an empty prompt, cancel the running turn; when idle, press it twice within 2 seconds to quit. In a permission or escalation prompt, it answers no |

When a prompt is waiting for you, or a turn that ran 30 seconds or more finishes, the TUI asks the terminal for a desktop notification, or rings the bell where it can't (`notifications` in [configuration.md](../configuration.md#notifications)).

Role commands change the current session; add `--save` to make the change your default (written to the user config). Keys an organization enforces can't be changed. The status line shows where the session is on the ladder (`step 1/2 qwen3-coder-480b, 2 more`) and the permission mode when it isn't `default`.

## Goals

`/goal <objective>` hands the agent a job that takes more than one turn: "make `bun test` pass", "move every caller off the old config API". The objective is your first prompt. When a turn ends, Switchback starts another with a short reminder of the goal, until one of these happens:

- the model calls the `goal` tool to say it's **done** or **blocked** (it needs you), with a summary
- the goal reaches `goal.maxTurns` turns (25) or `goal.maxMinutes` minutes (120; [configuration.md](../configuration.md))
- three turns in a row fail
- you press Esc, which stops the turn and the goal, or type `/goal stop`, which lets the running turn finish

The active goal and its turn count stay above the prompt (`◎ goal · turn 3/25 · …`), and the conversation notes when it starts and ends. Nothing is approved for a goal. Each turn routes as usual, so budgets and `remote` blocks still apply, and a permission prompt waits for you. A prompt you type while a goal runs is handled first, and then the goal goes on. Goals aren't saved: resuming the session later doesn't restart one ([ADR 0024](../adr/0024-goals.md)).

## Implementation notes

- The TUI runs in the terminal's alternate screen (Ink's `alternateScreen`). Each transcript row is rendered to lines once (`renderToString`) and cached by the identity of its items, which the view reducer replaces only when they change, so a long session costs what's on screen. The viewport is a window onto those lines.
- Ink reads keys from a stand-in for stdin that takes the wheel's mouse sequences out first (`tui/mouse.ts`), so they never reach the prompt as text.
- Marks in the status bar and transcript (`⌂`, `▲`, the mode's `»`, `║`, `!`) come from `@switchback/client/format` and are one terminal cell everywhere. Emoji-capable symbols such as `☁`, `⚠`, and `⏸` are drawn two cells wide by Windows Terminal and others while Ink counts one, which covers the space after them.
- Child processes the user doesn't look at (commands, hooks, git, ripgrep, clipboard helpers) start with `windowsHide` (`hideWindow` in the engine), so on Windows a detached engine doesn't open a console window for each one.
- Assistant text is plain while it streams and is rendered as Markdown (with syntax-highlighted code) once the turn finishes, so half-written Markdown never flickers.
- Colors come from roles in `tui/theme.ts` (brand, local, remote, added, removed, ...), never from color names in components.
- All display state comes from `reduce()` in `@switchback/client/view`, and what a tool call says about itself from `@switchback/client/tool-display`. If something looks wrong in both clients, fix it there.
