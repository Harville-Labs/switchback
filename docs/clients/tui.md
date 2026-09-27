# Terminal UI

`harness` with no arguments opens the TUI in the current directory. It's built with [Ink](https://github.com/vadimdemedes/ink) and attaches to the workspace's shared engine daemon (starting it if needed), the same one VS Code uses, so sessions are shared live between them. `--no-daemon` runs a private in-process engine instead; `--mock` always does.

## First run

With no config file anywhere, `harness` offers to run `harness init` before opening the UI. Declining opens the UI anyway; turns run remotely until a local model is configured.

## Resuming

Sessions are saved as you go. `harness --continue` (`-c`) reopens the most recent session in this workspace, and `harness --session <id>` opens a specific one. Inside the TUI, `/sessions` lists them and `/resume <n>` switches. History is rebuilt from the transcript through the shared view model, so it looks the same as it did live (minus streamed reasoning).

## Screen

```
❯ where is the retry logic?
☁ claude-opus-5 · context-overflow: ~29000 tokens exceeds 85% of local's 32768 window
↳ ✓ explore find retry logic · local · 6 tool calls
Retries live in src/http/client.ts:88 ...
╭────────────────────────────────────────────╮
│ ❯ Ask anything, or /help                   │
╰────────────────────────────────────────────╯
 build · route auto · last remote     session $0.0142 · today $0.31/$5.00 · saved ~$4.12
```

- `⌂` lines are local routing decisions and `☁` lines are remote. Plain default decisions for the model already in use are hidden to reduce noise.
- `●`/`✓`/`✗` mark tool calls: running, succeeded, failed.
- `↳` rows are subagents, showing their tier, tool-call count, and current activity.
- The status bar shows the agent, route preference, last tier used, session cost, today's spend against budget, and month-to-date savings.

## Commands and keys

| Input | Effect |
|---|---|
| `/local`, `/remote`, `/auto` | Route the following prompts |
| `/agent <name>` | New session with that agent |
| `/agents` | List agents and where they came from |
| `/new` | New session with the default agent |
| `/sessions` | Saved sessions in this workspace, newest first |
| `/resume <n\|id>` | Switch to a saved session (number from `/sessions`) |
| `/compact` | Summarize earlier messages now. It also happens automatically as a session grows; the full history is kept |
| `/usage [rule\|agent\|model]` | The last 7 days: spend, budget, savings, cache hits, and a breakdown (by rule unless you pick another) |
| `/help`, `/exit` | |
| `@path` | Mention a file; a menu completes paths (Tab or Enter to insert). The file's contents are attached to the prompt. |
| `↑` / `↓` | Move between lines, then browse this workspace's prompt history |
| Option/Alt+Enter, Ctrl+J, or `\` then Enter | Newline |
| Ctrl+A / Ctrl+E, Ctrl+U, Ctrl+W | Line start / end, delete to line start, delete word |
| `esc` | Cancel the running turn (or close the mention menu) |
| `y` / `a` / `n` | Answer a permission prompt: once, always, deny |
| `y` / `n` | Answer an escalation prompt |
| `ctrl+c` | Quit |

## Implementation notes

- Finished items render through Ink's `<Static>`, so long sessions don't re-render history. Assistant text is plain while it streams and is rendered as Markdown (with syntax-highlighted code) once the turn finishes, so half-written Markdown never flickers.
- All display state comes from `reduce()` in `@harness/client/view`. If something looks wrong in both clients, fix it there.
