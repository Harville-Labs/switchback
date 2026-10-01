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

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=isaiah-harville.switchback) or [Open VSX](https://open-vsx.org/extension/isaiah-harville/switchback) (Cursor, VSCodium, and other Open VSX editors): `code --install-extension isaiah-harville.switchback`. While Switchback is 0.x, every version is a pre-release, so add `--pre-release` on the command line.

Each release builds one `.vsix` per platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`) with the engine binary inside, so installing the extension is all a user needs. A universal `.vsix` without a binary is the fallback on every other platform and uses `switchback` from PATH. The marketplaces pick the right one. The same files are attached to the GitHub release, and the installers can add the matching one using the first editor command they find (`code`, `code-insiders`, `codium`, `cursor`): `curl -fsSL https://switchback.harville.ai/install.sh | sh -s -- --vscode` on macOS and Linux, or `& ([scriptblock]::Create((irm https://switchback.harville.ai/install.ps1))) -VSCode` in PowerShell on Windows.

### Publishing

`bun run --cwd apps/vscode package` builds a `.vsix` the way releases do: it copies the root `CHANGELOG.md` in for the Changelog tab and points relative links at the repository. CI packages on every push, so manifest and README problems surface before a release.

After a release is created, the **Publish VS Code extension** workflow (`.github/workflows/publish-vscode.yml`) publishes its `.vsix` files. Run it by hand with a tag to retry or to publish an existing release; versions already published are skipped. 0.x versions go out as pre-releases. Versions with a SemVer pre-release tag (`1.0.0-rc.1`) aren't published, because extension versions must be plain `major.minor.patch`.

The Marketplace takes no long-lived secret. Azure DevOps personal access tokens are retired on 2026-12-01, so the workflow signs in with Microsoft Entra ID through GitHub OIDC and runs `vsce publish --azure-credential`. One-time setup:

1. The extension publishes under the `isaiah-harville` publisher (<https://marketplace.visualstudio.com/manage>). Its ID is the first half of the extension ID, so it can never change.
2. In Azure, create a **user-assigned managed identity**. An app registration signs in but then fails to publish with `InvalidAccessException`.
3. On the identity, add a federated credential: GitHub Actions, organization `Harville-Labs`, repository `switchback`, entity type **Environment**, environment `marketplace`.
4. Set the repository variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` from the identity's **Overview**.
5. Run **Publish VS Code extension** for any release tag. The publish step fails until the next step is done, but the run's summary shows the identity's Marketplace ID ("Show the Marketplace identity"). Add that ID (not the client ID) under the publisher's **Members** as a **Contributor**, then run the workflow again.

For Open VSX, sign in at <https://open-vsx.org> with an Eclipse account, sign the publisher agreement, create the namespace with `bunx ovsx create-namespace isaiah-harville -p <token>`, then either set the `OVSX_PAT` secret or configure trusted publishing for this repository and set the variable `OVSX_TRUSTED_PUBLISHING` to `true`.

If a marketplace isn't configured, the workflow skips it with a warning.

## Planned

Terminal output as an attachment. See the [roadmap](../roadmap.md).
