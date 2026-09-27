# VS Code extension

The extension (`apps/vscode`) is a thin client. On activation it spawns `harness serve --stdio` in the first workspace folder and relays everything through the protocol. It contains no agent logic.

## Features

- **Chat view** in the activity bar. It renders from the same view-model reducer as the TUI, so both show the same routing lines, tool rows, subagent rows, and prompts.
- **Markdown answers** with syntax-aware code blocks and **Copy** / **Insert** (at the cursor in the active editor). Model output can't run script: raw HTML is shown as text, links are limited to http(s) and mailto and open in your browser.
- **Session history**: the history button (or **Harness: Open Session…**) lists saved sessions for the workspace and reopens one.
- **Routing control**: a dropdown in the chat, the status bar item (click to change), and the **Harness: Set Routing** command.
- **Status bar**: current route preference, last tier used (`$(home)` local, `$(cloud)` remote), and session cost.
- **Editor context chips** above the input: the current selection (on by default when you have one), the active file, and its problems (errors and warnings). Included chips are sent as prompt attachments; the engine reads the file range itself, so what the model sees is exactly what's on disk. **Ask About Selection** (editor context menu) turns on the selection chip and focuses the chat.
- **Edit review in the diff editor.** Proposed edits open side by side with the file on disk, with **Accept** / **Reject** buttons in the editor title (also in the chat and the command palette). The tab closes when the request is answered anywhere. Turn off with `harness.reviewEditsInDiffEditor`.
- **Permission and escalation prompts** appear inline in the chat.
- **Setup**: if no local model is configured, the extension offers **Set Up Models**, which runs `harness init` in a terminal and restarts the engine when it closes.
- **Config validation**: `.harness/config.json` and `~/.config/harness/config.json` are validated and autocompleted against the bundled schema.
- Commands: Set Up Models, New Session, Cancel, Show Usage and Savings, Restart Engine, Show Engine Logs.

## Settings

| Setting | Default | |
|---|---|---|
| `harness.executablePath` | empty | The binary to run (`<path> [args] serve --stdio`). Empty uses the engine bundled in the platform-specific `.vsix`, falling back to `harness` on PATH. |
| `harness.executableArgs` | `[]` | Extra leading args (e.g. a script path when the path is `bun`) |
| `harness.defaultRoute` | `auto` | Initial routing preference |

Project behavior (models, routing, permissions, agents) comes from the same `.harness/config.json` the CLI uses. There are deliberately no VS Code settings for it, so the two clients can't be configured differently.

## Development

1. `bun install`
2. Open the repo in VS Code and run **Run Extension** (F5). It builds `apps/vscode/dist` and opens this repo in an Extension Development Host. The repo's `.vscode/settings.json` points `harness.executablePath` at `bun` and `harness.executableArgs` at `apps/cli/src/main.ts`, so the extension runs the dev CLI from source.
3. To work without models, add `"--mock"` to `harness.executableArgs`. `${workspaceFolder}` is expanded in both settings.

Run the integration tests (a real VS Code instance with the extension, talking to the engine in `--mock` mode) with `bun run --cwd apps/vscode test`. CI runs them on every push.

Build a `.vsix` with `bun run --cwd apps/vscode package`.

## Distribution

Each release publishes one `.vsix` per platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`) with the engine binary inside, so installing the extension is all a user needs. A universal `.vsix` without a binary uses `harness` from PATH. When `VSCE_PAT` / `OVSX_PAT` repository secrets are set, releases also publish to the VS Code Marketplace and Open VSX; otherwise that step is skipped.

## Planned

Terminal output as an attachment, attaching to a shared engine daemon so the TUI and VS Code can share a live session, and bundling a platform-specific engine binary in the `.vsix`. See the [roadmap](../roadmap.md).
