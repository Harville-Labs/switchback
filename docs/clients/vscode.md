# VS Code extension

The extension (`apps/vscode`) is a thin client. On activation it spawns `switchback serve --stdio` in the first workspace folder and relays everything through the protocol. It contains no agent logic.

## Features

- **Chat view** in the activity bar. It renders from the same view-model reducer as the TUI, so both show the same routing lines, tool rows, subagent rows, and prompts. A subagent row expands to show that subagent's own routes, tool calls, nested subagents, and report; expanded rows stay open while the session updates.
- **Markdown answers** with syntax-aware code blocks and **Copy** / **Insert** (at the cursor in the active editor). Model output can't run script: raw HTML is shown as text, links are limited to http(s) and mailto and open in your browser.
- **Session history**: the history button (or **Switchback: Open Session…**) lists saved sessions for the workspace and reopens one.
- **Routing control**: a dropdown in the chat, the status bar item (click to change), and the **Switchback: Set Routing** command.
- **Status bar**: current route preference, last tier used (`$(home)` local, `$(cloud)` remote), and session cost.
- **Editor context chips** above the input: the current selection (on by default when you have one), the active file, and its problems (errors and warnings). Included chips are sent as prompt attachments; the engine reads the file range itself, so what the model sees is exactly what's on disk. **Ask About Selection** (editor context menu) turns on the selection chip and focuses the chat.
- **Edit review in the diff editor.** Proposed edits open side by side with the file on disk, with **Accept** / **Reject** buttons in the editor title (also in the chat and the command palette). The tab closes when the request is answered anywhere. Turn off with `switchback.reviewEditsInDiffEditor`.
- **Permission and escalation prompts** appear inline in the chat.
- **Setup**: if no local model is configured, the extension offers **Set Up Models**, which runs `switchback init` in a terminal and restarts the engine when it closes.
- **Config validation**: `.switchback/config.json` and `~/.config/switchback/config.json` are validated and autocompleted against the bundled schema.
- **Privacy and savings**: tool rows that brought in private content show `🔒 stays local`, and the status line shows `🔒 local only` once a session is pinned ([privacy.md](../privacy.md)); it also shows what the session has saved so far.
- **Telemetry**: Switchback telemetry is off unless you opt in with `switchback telemetry on`, and VS Code's own `telemetry.telemetryLevel: off` keeps it off regardless ([telemetry.md](../telemetry.md)).
- Commands: Set Up Models, Install Terminal Command, New Session, Cancel, Show Usage and Savings, Show Session Receipt, Set Remote Review of Local Edits, Compact Conversation, Restart Engine, Show Engine Logs.

## Settings

| Setting | Default | |
|---|---|---|
| `switchback.executablePath` | empty | The binary to run (`<path> [args] serve --stdio`). Empty picks one as described in [Which engine runs](#which-engine-runs). |
| `switchback.executableArgs` | `[]` | Extra leading args (e.g. a script path when the path is `bun`) |
| `switchback.defaultRoute` | `auto` | Initial routing preference |
| `switchback.sharedEngine` | `true` | Attach to the workspace's shared engine so the terminal UI and VS Code see the same live sessions |
| `switchback.reviewEditsInDiffEditor` | `true` | Open proposed edits in the diff editor with Accept / Reject |

## Which engine runs

The terminal UI and the extension work alone or together. With both installed, they run one engine:

1. `switchback.executablePath`, when set.
2. Otherwise the `switchback` CLI, from PATH or from where the installer puts it (`~/.local/bin`), when it's at least as new as the engine bundled in the extension. People who use the terminal too then run one engine everywhere.
3. Otherwise the bundled engine. If there's none (the universal `.vsix`, on a platform without a build) and no CLI, the extension offers to install the CLI.

The engine log (**Switchback: Show Engine Logs**) names the binary it chose and why. With `switchback.sharedEngine`, the extension and the TUI attach to one engine per workspace, and the newest version takes over from an older idle one ([architecture.md](../architecture.md#the-shared-daemon)). When they can't share, for example because an older terminal is still attached, the extension says so and runs its own engine.

**Switchback: Install Terminal Command** runs the official installer in a terminal: `install.ps1` in PowerShell on Windows, `install.sh` elsewhere. It installs where the extension runs, including SSH, WSL, and dev container hosts. Then it restarts the engine so the extension can pick up the CLI.

Project behavior (models, routing, permissions, agents) comes from the same `.switchback/config.json` the CLI uses. There are deliberately no VS Code settings for it, so the two clients can't be configured differently.

## Development

1. `bun install`
2. Open the repo in VS Code and run **Run Extension** (F5). It builds `apps/vscode/dist` and opens this repo in an Extension Development Host. The repo's `.vscode/settings.json` points `switchback.executablePath` at `bun` and `switchback.executableArgs` at `apps/cli/src/main.ts`, so the extension runs the dev CLI from source.
3. To work without models, add `"--mock"` to `switchback.executableArgs`. `${workspaceFolder}` is expanded in both settings.

Run the integration tests (a real VS Code instance with the extension, talking to the engine in `--mock` mode) with `bun run --cwd apps/vscode test`. CI runs them on every push.

Build a `.vsix` with `bun run --cwd apps/vscode package`.

## Distribution

Each release publishes one `.vsix` per platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`) with the engine binary inside, so installing the extension is all a user needs. The installers can add the extension too, using the first editor command they find (`code`, `code-insiders`, `codium`, `cursor`): `curl -fsSL https://switchback.harville.ai/install.sh | sh -s -- --vscode` on macOS and Linux, or `& ([scriptblock]::Create((irm https://switchback.harville.ai/install.ps1))) -VSCode` in PowerShell on Windows. A universal `.vsix` without a binary uses the `switchback` CLI. When `VSCE_PAT` / `OVSX_PAT` repository secrets are set, releases also publish to the VS Code Marketplace and Open VSX; otherwise that step is skipped.

## Planned

Terminal output as an attachment, and bundling a platform-specific engine binary in the `.vsix`. See the [roadmap](../roadmap.md).
