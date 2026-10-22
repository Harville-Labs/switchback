# Changelog

All notable changes to Switchback. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow SemVer.

## [Unreleased]

### Added
- **The prompt-cache hit rate is in the status bar.** The TUI's status bar and VS Code's composer show how much of the session's input came from the provider's cache (`cache 91%`), with the latest turn's when it differs. `call.stats` events carry each call's usage. `--mock` simulates a prefix cache, so the rate shows there too

### Changed
- **More of each request hits the cache.** Claude requests add a cache breakpoint on the system prompt, so tools and system stay cached after compaction or past the 20-block lookback. OpenAI and Azure OpenAI requests send the session ID as `prompt_cache_key`, so a session's calls reach the same cache

### Fixed
- **Setup with one model doesn't ask which model does what.** It used to offer an escalation ladder, reviewers, and a subagent model that a single model can't have

## [2.3.0] - 2026-10-21

### Added
- **Starting from OpenCode reads its newer config format.** `providers` with `package` and `settings.baseURL`, a model's `modelID`, agents' `provider/model#variant`, the `permissions` list, and `mcp.servers` come over like the older `provider`, `permission`, and `mcp`
- **Sampling settings per model.** `temperature`, `topP`, `topK`, and `body` (extra request fields such as vLLM's `min_p` or `chat_template_kwargs`) go with every request to that model, on every provider that takes them. Starting from OpenCode brings a model's `body` over as these, a `#variant` with its own `body` as a model of its own, and image input as `vision`
- **Starting from OpenCode brings its agents and compaction settings.** Agents keep their description, prompt, mode, step limit, and model; tools an agent denies are left out of its tool list. `compaction`'s `auto`, `keep.tokens`, and `buffer` become `enabled`, `keepRecent`, and `threshold`
- **Models on your own endpoints show up without running setup again.** Each launch asks every OpenAI-compatible provider (vLLM, Ollama, LM Studio, a team's server) what it serves, as it already did for Claude Code and Codex sign-ins, and `/models refresh` asks right away and says what's new or gone. `listModels: false` turns this off for one provider
- **`/init` runs setup inside Switchback.** The TUI asks setup's questions in a panel above the prompt, the same ones `switchback init` asks, and the new config is in use as soon as it's saved. VS Code's `/setup` is `/init` too

### Changed
- **`switchback init` opens Switchback on setup,** and so does a first run with no config, instead of asking in the terminal before the UI opens. With any answer given as a flag, or `--yes`, `switchback init` still asks in the terminal
- **Web search runs without asking.** `permissions.websearch` is a level of its own, default `allow`: only the query leaves the machine, to the search backend. Fetching a page still asks under `permissions.web`, and `web: deny` turns both off
- **The docs tool tells the model that config changes apply live.** It used to say they needed a restart, so the model told people to restart when they didn't have to

## [2.2.0] - 2026-10-21

### Added
- **Claude Code and Codex models can use Switchback's tools.** Each turn on one serves `task`, `merge_worktree`, `escalate`, `docs`, and `skill` to it over MCP on a loopback address, so asking it for a subagent starts a Switchback subagent in its own tab. Claude Code's own subagent tool is off while `task` is offered
- **Tab switches to the next model.** In the TUI, with no menu open, it makes the model after the current one, in config order, the current model for the session and says `Switched to <model>.`; pressed again it goes round them all
- **The TUI says when a new version is out.** At launch it checks GitHub's releases, at most once a day, and when yours is older says so in the chat with `switchback update` to update. `updates.check: false` turns it off
- **Every model is told how to work in Switchback.** The system prompt, and each Claude Code or Codex turn, explains subagents and their tabs, escalation, and reading the docs before changing settings

### Changed
- **Alt+↓ and Alt+↑ move between subagents and the session** in the TUI, in place of Tab. Alt+↓ shows the next subagent; Alt+↑ comes back to the session
- **Alt+↑ no longer escalates.** `/up` still does, and **Escalate now** in VS Code

## [2.1.0] - 2026-10-21

### Added
- **Tab shows a running subagent in place of the session.** Tab moves through each subagent, then back to the session; the status bar says which one is in view, and `/model` there sets the subagent model
- **More ways to move between tabs.** Ctrl+Tab and Ctrl+Shift+Tab cycle tabs, a click on a tab switches to it, and Ctrl+W on an empty prompt closes the tab in front (with text typed it still deletes a word). Most terminals keep Ctrl+Tab for their own tabs, so it reaches Switchback only once you unbind it there
- **The model can ask to escalate.** A new `escalate` tool, which every session has, asks for the next step to run one model up the ladder, with a reason. The new `model-escalation` routing rule follows `escalation.policy`, privacy, and budgets like the other escalations, and the system prompt says when to use it
- **Web search works without setup.** When `web.search` isn't set, `websearch` uses Exa's hosted search, which needs no key; an optional `apiKey` raises its rate limits. Each search still asks first unless you allow `websearch`
- **VS Code sends the workspace's problems.** The problems chip counts errors and warnings across the whole workspace, with the active file's first, and attaches them as context
- **The terminal UI uses kitty's keyboard protocol** where the terminal supports it, so keys the terminal would otherwise merge, such as Ctrl+Tab and Shift+Enter, arrive as themselves

### Changed
- **`switchback init` asks less.** It writes the config without showing it first, and allows the common test, build, and lint commands for every toolchain instead of asking which to allow. The `config` kind of `setup.note` is gone
- **New Session in VS Code starts on a clear chat.** The previous session is saved and `/resume` brings it back
- **An exact command name wins over longer ones**, so `/model` and Enter runs `/model`, not `/models`

## [2.0.0] - 2026-10-20

### Added
- **`switchback usage` is a dashboard in a terminal.** Pick today, the last 7 days, the month, the year, or all time, step back through earlier periods with ← and →, and see spend, savings, budget meters, how tokens split between local and remote models, a chart per day or month, and the breakdown by rule, agent, or model. `--from`/`--to` report any span of days, `--period` also takes `year` and `all`, and piped output and `--json` work as before. The `usage.get` protocol method takes a `range` and returns `byDay`
- **Agents have modes, limits, and their own reasoning effort.** An agent's `mode` says whether it runs as a session's agent, as a subagent, or both; `effort` and `maxSteps` set its reasoning effort and step limit; and `agents` limits which subagents it may call (an empty list removes its `task` tool). The new `agents` config key adds agents, changes built-ins field by field, and turns them off with `disable: true`. `explore` now runs at `low` effort
- **The parent picks a subagent's model and effort per task.** The `task` tool takes `model` and `effort`; an agent pinned to the local model refuses a remote one. `subagents.effort` sets the default for subagents whose agent sets none
- **`/effort` changes reasoning effort for the current session.** It overrides the agent's and model's effort for that session only, and `/effort default` goes back. `--effort` sets it at launch, it works the same in VS Code, and the protocol adds `session.setEffort`, `effort` on `session.create`, and the `effort.changed` event
- **A Claude or ChatGPT plan brings all its models.** Claude Code and Codex providers get every model their sign-in offers without listing them in config. Switchback asks the CLIs at launch (Codex through `codex app-server`, Claude Code through the Agent SDK) and caches the answer in `subscription-models.json` in the data folder, so newly released models show up without an update or re-running setup. Setup no longer asks which Claude Code or Codex model to add; `--remote-model` still picks one
- **Setup asks for an API key** for every provider that signs in with one (Anthropic, OpenAI, Azure OpenAI, DeepSeek, Gemini, Foundry, OpenCode, OpenRouter, and optionally OpenAI-compatible servers) when none is in the environment. The key is typed hidden, saved only in the user config, which setup makes readable by you alone, and never shown back. A project config never gets a key, and leaving the answer empty keeps reading the environment variable. `setup.ask` questions carry `secret: true` for this

### Fixed
- **A permission prompt shows only in the client that owns the session.** A terminal chat's prompt no longer pops up in VS Code, and the reverse

### Removed
- **No more Intel Mac build.** Releases no longer include a `darwin-x64` binary or `.vsix`. On an Intel Mac, the installer and `switchback self-update` now say there is no build instead of failing to download one. Apple silicon under Rosetta still gets the arm64 build

## [1.6.0] - 2026-10-20

### Added
- **Start from your OpenCode setup.** On a first run, when an OpenCode config is found, `switchback init` first asks whether to start from it: its models (the main one stays current), MCP servers, and permissions come over and are shown before anything is written; API keys stay where OpenCode keeps them, and setup names the environment variables Switchback needs. `--from opencode` does it unattended (ADR 0022)

### Fixed
- **Config changes made outside a running engine take effect.** The shared engine reloads `~/.switchback/config.json` and the project's config files when they change, so `switchback init` in a terminal, `switchback config edit`, and editor saves apply without closing every client first. A file that doesn't parse is reported and the config in effect stays
- **`switchback doctor` points out `~/.config/switchback` and `~/.local/share/switchback`** left from before 1.1.0, which nothing reads
- **Setting the current model during setup (`--current`) no longer leaves it on the escalation ladder too**
- VS Code webview tests no longer fail depending on which test file loads the Markdown renderer first

## [1.5.0] - 2026-10-19

### Added
- **An unavailable model is retried with backoff before the router falls back.** A call that fails with a connection error, 429, or 5xx before any output is retried up to 5 times, waiting 1s, 2s, 4s, and so on (at most 30s), with a notice each time. Set `retry.attempts`, `retry.initialDelayMs`, and `retry.maxDelayMs` to change it; `retry.attempts: 0` falls back at once as before

### Changed
- **VS Code: a calmer chat view.** Buttons take VS Code's own shape, permission and escalation prompts are cards with an accent edge, the controls under the input are a quiet toolbar, and the transcript leaves room between your message, tool work, and the answer. An escalation's reason sits on its own line

## [1.4.0] - 2026-10-17

### Added
- **Tabs and a sessions dashboard, in the TUI and VS Code.** Open several sessions at once; a tab in the back keeps working and says when it needs you (`?` waiting, `●` working, `✓` finished, `✗` failed). The dashboard (Ctrl+T in the TUI, the grid button or **Switchback: Show Sessions** in VS Code) lists every open tab with what it's doing, its model, and its cost, then the sessions working or waiting in other windows on the shared engine; open one to follow it live. TUI: Alt+1…9 and Alt+←/→ switch, `/tab new|<n>|close`, `/tabs`. VS Code: a tab strip in the chat and **Switchback: New Tab**. Closing a tab doesn't stop its session (ADR 0021)
- **VS Code: a model dropdown under the input** switches the current model for the session; the models that were current stay as backups. **Make this my default** saves it
- **TUI: `/current` with no argument opens a model picker**, and the status bar names the current model

### Changed
- **The `start` role is now the current model**: `routing.current`, `/current`, `--current`, and **Model** in VS Code (ADR 0021). `routing.start`, `/start`, and `--start` still work; Switchback moves `routing.start` to `routing.current` the next time it writes your config
- **Protocol version 2** (affects third-party clients only; the CLI and extension update together): `SessionRoles.start` and `session.setRoles`' `start` are now `current`. An older shared engine steps aside for the new version as usual

### Fixed
- A permission prompt from a session open in another window no longer shows in this one's chat

## [1.3.2] - 2026-10-10

### Changed
- **The hosted console's source is now private** (ADR 0020, supersedes ADR 0014). Everything in this repository is Apache-2.0 with no exceptions. The organization protocol is unchanged and still documented in docs/organizations.md

## [1.3.1] - 2026-10-10

### Fixed
- Releases publish `@harville-labs/switchback-org`; 1.3.0's publish failed

## [1.3.0] - 2026-10-10

### Added
- Each release attaches `install.sh` and `install.ps1`
- The organization protocol (the policy and telemetry formats, the sign-in client, and the install command) is its own package, `packages/org`, published privately to GitHub Packages as `@harville-labs/switchback-org` for the hosted console

## [1.2.1] - 2026-10-10

### Fixed
- **VS Code: permission, plan, and escalation prompts can be answered again.** Since 1.1.0 none of their buttons did anything, so a turn waiting on a prompt waited forever

### Changed
- **Setup in VS Code without the CLI**: with nothing configured, setup starts by itself when the extension loads (and **Set Up Models** runs it again), asking the same questions as `switchback init` in VS Code's own quick picks, using the engine bundled with the extension, and the new config applies at once. The questions now live in the engine and reach clients over the protocol (`setup.start`, `setup.answer`, `setup.cancel`; `setup.ask`, `setup.note`, `setup.finished`), so the terminal and VS Code set up the same way
- `switchback upgrade` and `switchback update` run `switchback self-update`
- **Switchback has its own domains** (ADR 0019): the site and docs are at switchback.sh, and the console is at app.switchback.sh. Install with `curl -fsSL https://switchback.sh/install.sh | sh` or `irm https://switchback.sh/install.ps1 | iex`. `switchback login --site` and the default `telemetry.endpoint` use app.switchback.sh. The old addresses redirect. Sites with single sign-on need their identity provider's redirect URI changed to app.switchback.sh

## [1.2.0] - 2026-10-09

### Added
- **`docs` tool**: the model reads Switchback's own documentation, built into the binary, so you can ask it how Switchback works or to change a setting. Every session has it; it needs no permission. See docs/tools.md#asking-about-switchback
- **Your own `AGENTS.md`**: `~/.switchback/AGENTS.md` holds instructions for every project. Sessions get it before the project's `AGENTS.md`. `switchback doctor` shows each file's size in tokens and warns when they crowd a small local model. See docs/commands-and-skills.md#agentsmd
- **AGENTS.md edits apply without a restart**: every engine watches both files. New sessions start with the new text, and running sessions get it with their next message, without rewriting the system prompt, so prompt caches keep working (ADR 0017)
- **Files outside the workspace**: the model reads and searches them like the workspace (`permissions.read`), and edits them after asking, instead of being refused. **Always** opens the folder for edits; allow rules such as `edit(~/Projects/shared-lib/)` open folders ahead of time, and `permissions.outsideWorkspace: "deny"` turns it all off. Switchback's data, its sign-in, and credentials (`bash.sandbox.denyRead`) stay off limits in every mode. See docs/permissions.md#outside-the-workspace
- **Config edits are checked**: an edit or write that would leave a Switchback config file unparseable or invalid fails with the reason before you're asked. Your user config can now be edited this way, always with a prompt and a diff
- `privacy.localOnlyPaths` takes folders anywhere on the machine (`~/customers/`)
- Protocol (additive): `permission.requested` carries `reason`
- **Agent Client Protocol**: `switchback acp` runs Switchback as an agent for Zed, JetBrains IDEs, and other editors that speak ACP. Sessions are shared live with the TUI and VS Code through the workspace's engine, and routing decisions, permission prompts, escalations, modes, and the checklist all come through. See docs/clients/acp.md
- **OpenCode Go and Zen**: a provider for OpenCode's subscription (Go) and pay-as-you-go (Zen) gateways, with one `OPENCODE_API_KEY`. Each model goes to the API OpenCode serves it on (Chat Completions, Anthropic Messages, or Responses). `switchback init` offers it, with models from OpenCode's live list. See docs/providers.md#opencode-go-and-zen
- **See what isolated subagents did**: their rows show the branch while they run and what they changed when they're done; `/worktrees` (both clients) and `switchback worktrees` list every branch they made, with state, size, and why; `/worktrees <branch>` shows the diff, side by side in VS Code. See docs/subagents.md#seeing-what-they-did
- **`merge_worktree` tool**: the parent agent can merge an isolated subagent's branch into your checked-out branch, always after asking you with the diff. Refused while you have uncommitted changes; a conflict aborts and names the files
- Protocol (additive): `worktrees.list`, `worktrees.diff`, and `worktree` on `subagent.started` and `subagent.completed`

### Changed
- **`switchback doctor` is easier to read**: section headings stand out, ✓ is green, ✗ red, warnings yellow, and details are dimmed, in a terminal only (piped output stays plain). Paths under your home directory show as `~/...`
- Permission prompts say why they ask ("Asking because: outside the workspace.") instead of calling every reason a rule
- **Simpler setup** (#121): `switchback init` asks "Do you have any local model endpoints?", takes each endpoint's URL (servers running here are offered), and lists its models as a checklist; then "Set up any remote providers?", one provider at a time. The first run goes straight into it, and it writes to the user config unless you pass `--scope project`. Lists in setup stop at the ends instead of wrapping around

## [1.1.0] - 2026-10-07

Upgrading: three changes need action. Move `~/.config/switchback` and `~/.local/share/switchback` into `~/.switchback` (or re-run `switchback init`); expect `bypassPermissions` to stop asking where ask rules used to; and rename `restrictions.allowUserPermissionRules` to `allowUserPermissions` in organization policies.

### Added
- **Full-screen terminal UI**: the TUI takes over the terminal like an editor, with the transcript above and the input fixed at the bottom; Page Up/Down and the mouse wheel scroll it, and quitting restores the shell and prints how to resume. Hold Shift (Option in macOS Terminal and iTerm2) to select text
- **Tool calls say what they did**, in both clients: lines read, files listed, matches found, the first lines a command printed (with its exit code when it failed), and an edit's size and diff, with line numbers and tinted bands in the TUI. Runs of reading and searching fold into one **Explored** block. `ctrl+o` expands thinking, output, diffs, and explored calls in full
- **"No, and tell it what to do instead"** on permission prompts (**Deny with a note…** in VS Code): the model gets the note with the refusal. Protocol: `permission.respond` takes `feedback`
- **Prompts as lists** in the TUI: arrows and Enter, or the option's number; the old letters still work
- **Status bar**: how much of the model's context is left, the mode as a badge, and cost only once there is one. The working line shows tokens written and the model working
- **Themes**: `/theme dark|light|plain`, remembered between sessions
- Protocol (additive): `tool.completed` carries `diff` for edits and writes (display only); `route.decided` carries the model's `contextWindow`
- The mock provider's `mock:tool` takes an array of calls, for demos of parallel tool use
- **Default permissions**: `switchback init` writes a starting set of rules into a new user config: read-only commands (`find`, `grep`, `rg`, `git log`, `git diff`, ...) run without asking; commits, pushes, history rewrites, and package publishes ask. Setup also offers test, build, and lint presets per ecosystem, preselected from the workspace. See docs/permissions.md#default-rules
- **Organizations hand out permissions**: `switchback login` replaces the member's permissions with the policy's
- **Windows command sandbox** (alpha): commands run as a separate account, fenced by file ACLs and a network filter, through the sandbox runtime's Windows backend. One-time setup with one administrator prompt: `switchback init` offers it, or `switchback sandbox install`
- **Setup prompts** use the arrow keys, and model lists from an endpoint (OpenRouter, OpenAI-compatible, local servers) filter as you type

### Changed
- **Breaking:** everything of Switchback's now lives in `~/.switchback` on every platform (config, agents, commands, skills, and `data/` for sessions and the ledger), instead of `~/.config/switchback` and `~/.local/share/switchback`. `XDG_CONFIG_HOME` and `XDG_DATA_HOME` no longer apply; move your files, or re-run `switchback init`
- **Breaking:** `bypassPermissions` never asks: ask rules, running outside the sandbox, and edits to `.switchback/` all go ahead. Deny rules still stop a call
- **Breaking:** `restrictions.allowUserPermissionRules` is now `allowUserPermissions`, and with `false` it also ignores members' permission levels and turns off **Always** at prompts
- `/permissions` and `switchback doctor` group rules by where they came from

## [1.0.0] - 2026-10-07

### Removed
- The pre-routing classifier (`routing.classifier`) and the TypeSafe Jev provider, which existed only to serve as it. Whether a prompt is "hard" depends on which model starts it, so a fixed rating couldn't be trusted. Escalation stays automatic when a model struggles or a prompt outgrows it; a config that still sets `routing.classifier` is told what replaced it

### Added
- **Claude Code and Codex as models**, on whatever they're signed in with (a Claude or ChatGPT plan, or a key): provider types `claude-code` and `codex`, offered by `switchback init` (`--remote claude-code`, `--remote codex`). Their models fill any role like any other; a turn routed to one is worked by the CLI with its own tools, resuming its own session, and told what it missed when it takes over. Claude Code's tool calls go through the permission policy; Codex is approved per turn and bounded by its sandbox. `billing: subscription` (the default) records their turns as free. Organizations can rule them out by provider type. See docs/providers.md
- **Escalate now**: `/up` (alt+↑ in the TUI, **↑ Escalate now** in VS Code) moves the session one step up the ladder: the running turn's next call, or your next prompt. It's your request, so it doesn't ask first; budgets and privacy still apply, and stickiness keeps the session there for a few calls. Protocol: `session.escalate`; rule `user-escalation`
- **Docs site** (#36): each release attaches its user docs (`switchback-docs-<version>.json`: the pages under "Using Switchback", rendered with GitHub's heading anchors; ADRs, architecture, the protocol, and the roadmap stay on GitHub) and tells harville.ai to publish them at harville.ai/switchback/docs, with a version picker and search. A test fails on any broken link between published pages
- VS Code: a **Get Started** walkthrough (open the chat, choose models, first prompt, routing, edit review, the terminal UI), offered from the "no local model" notice and the command palette; screenshots in the Marketplace listing, made reproducibly by `apps/vscode/scripts/screenshots.ts`; Marketplace questions go to GitHub issues; `install.sh --help` links the extension listings (#49)
- **More external runtimes** (#43): `claude-managed-agents` (an agent in a Claude Managed Agents sandbox; tool calls its policy marks `ask` go to Switchback's policy), `codex` (OpenAI Codex in this workspace through the Codex SDK; approved once per run and bounded by its sandbox mode, and refused while `privacy.localOnlyPaths` is set), and `bedrock-agentcore` (an agent deployed to AgentCore Runtime). Each streams progress to the subagent row; Managed Agents and Codex usage is priced from the catalog. See docs/subagents.md
- **MCP resources and prompts** (#44): `@<server>:<uri>` attaches a server's resource to a prompt (text as text, images as images), and the TUI's `@` completion offers them; the model can read them with `mcp__<server>__read_resource`. A server's prompts run as `/<server>:<prompt> args`, listed under **Custom** in both clients. `/mcp` lists resources and prompts, `mcp.list` returns them, and MCP tool results' images reach models with vision
- **Tokens per second** (#107): each route line ends with how fast that call answered (`52 tok/s`, from the first streamed token to the last), both clients show the last call's speed in their status, and `switchback usage --by model` (and `/usage model`) shows each model's average. New `call.stats` event; the ledger keeps each call's decode time
- **Image input** (#86): paste an image with **ctrl+v** in the TUI (an `[Image #n]` chip) or paste/drop it into the VS Code composer (a thumbnail); `@shot.png` mentions, dragged-in image files, and `read` on an image file attach the image too. A new `image` transcript part (and `images` on tool results), translated by the Anthropic (also Bedrock and Vertex), Chat Completions, Responses, and Gemini adapters. `models.<alias>.vision` says which models can see images (the catalog knows its own); others get a note in each image's place, and within a step the router prefers a member that can see them (rule `vision`). Images are checked by their bytes, limited to 3.75 MB, counted as about 1,600 tokens, and subject to `privacy.localOnlyPaths`. Protocol: an `image` attachment kind

### Changed
- A model's thinking no longer streams along one line. The TUI shows `✻ Thinking…` (then `✻ Thought`) and **ctrl+o** opens it as wrapped paragraphs, keeping to the last few lines while it streams; VS Code shows a **Thinking** row you click to open. Both clean up the text the same way (`formatReasoning` in `@switchback/client`)

## [0.7.0] - 2026-10-06

### Added
- **Model discovery and Azure OpenAI** (#73): `switchback init` learns more from local model servers and provider model lists, offers OpenRouter during setup, and supports Microsoft Entra ID authentication for Azure OpenAI. TypeSafe Jev can serve as the routing classifier.
- **Notifications** (#85): when a permission, plan, or escalation prompt is waiting, or a turn of 30 seconds or more finishes, the TUI asks the terminal for a desktop notification (OSC 9, 99, or 777 where the terminal shows them; the bell elsewhere and in tmux), and VS Code shows a notification with **Open Chat** while you can't see the chat. `notifications.mode` (`system`, `bell`, `off`) and `notifications.afterSeconds`; `initialize` reports them to clients. One tracker in `@switchback/client` decides when, for both clients
- **Custom commands and skills** (#80): Markdown prompts in `.switchback/commands/` or `~/.config/switchback/commands/` run as `/name args` (`$ARGUMENTS`, `$1`…`$9`; `description` and `args` frontmatter), listed under **Custom** in both clients' menus and in `/help`, and expanded by the engine, so `switchback run "/name"` works too. Skills in the open Agent Skills format (`.switchback/skills/<name>/SKILL.md`, or the same under `~/.config/switchback/`): their names and descriptions go in the system prompt, and the new `skill` tool loads one's instructions and files when the model needs them. New protocol method `commands.list`. See docs/commands-and-skills.md
- **Checklist** (#82): a `todo` tool the model uses to keep a plan for longer tasks (`pending`, `in_progress`, `done`; each call replaces the list). Both clients show it above the input while work is left and keep the calls out of the transcript; it comes back with a resumed session. It comes with every agent. docs/tools.md lists every built-in tool
- **Scripts and CI** (#83): `switchback run --output text|json|events` (one result object, or NDJSON events), `--allow`/`--deny` permission rules for the run, `--max-steps`, `--instructions` (added to the run's system prompt; `session.create` takes `instructions`), and `-c`/`--session` to continue a session. Exit codes: 0 done, 1 failed, 2 usage error, 3 finished but a tool call was refused (`tool.completed` carries `denied`). See docs/clients/headless.md
- **Checkpoints and rewind** (#79): every prompt makes a checkpoint, and every file a turn changes with edit or write (a subagent's in the same checkout too) is snapshotted first. `/rewind` (TUI), **Rewind…** and `/rewind` (VS Code), and `session.checkpoints`/`session.rewind` put files back (files created since are removed), continue the conversation in a new session from before that prompt (the original is kept; transcripts are append-only), or both. Shell commands' changes aren't tracked
- **Web tools** (#81): `webfetch` reads a page as Markdown (turndown), following same-host redirects and reporting cross-host ones; `websearch` searches through Brave, Tavily, or a self-hosted SearXNG (`web.search`). A new `web` permission category (default `ask`) with `webfetch(domain:...)` and `websearch` rules, and "always" granting just the domain. Neither runs in a session holding private content
- **Bash sandbox** (#32): commands run in an OS sandbox on macOS (Seatbelt) and Linux (bubblewrap and seccomp) through Anthropic's sandbox runtime. Writes go only to the workspace, temp, and package caches, never to the agent's own configuration or git hooks; credential directories and Switchback's own files can't be read; `read`/`edit` deny rules apply inside it; network is open unless restricted. Blocked operations are explained to the model. `bash.sandbox` (`mode: auto|on|off`, `network`, `allowWrite`, `denyRead`, `denyWrite`, `allowUnsandboxed`); a command can ask to run outside the sandbox, which always asks you. `/permissions` and `doctor` show whether it's on
- Edits to `.switchback/` always ask, even in `acceptEdits` and `bypassPermissions`, so an agent can't grant itself more
- **Hooks** (#78): `PreToolUse` (block, allow, or ask), `PostToolUse` (feedback on the result), `UserPromptSubmit` (block or add context), `Stop` and `SubagentStop` (send the model back to work), `SessionStart` (context), and `Notification` (Switchback is waiting on you). A hook answers with its exit code (2 blocks) or JSON (`permissionDecision`, `decision`, `additionalContext`, `continue`, `systemMessage`); hooks are read only from Switchback's own config files. Hooks add up across config layers; a project's wait for `switchback hooks trust`, and an organization can run only its own (`restrictions.allowUserHooks`). See docs/hooks.md
- Trust for project-defined MCP servers and hooks lives in one file, `trust.json` in the data directory; MCP servers trusted before need `switchback mcp trust` once more
- **Permission rules** (#77): `permissions.allow`, `ask`, and `deny` (`bash(git status:*)`, `read(.env)`, `edit(src/**)`, `mcp__github`). Deny beats ask beats allow. Rule lists add up across the user, project, personal (`.switchback/config.local.json`), and organization layers, so nobody below an organization can remove its deny rules. Compound commands are split, so an allow rule never approves `git status; rm -rf x`, and deny rules see through `sudo`, `env`, and `xargs`. Read deny rules also keep files out of glob and grep results. A prompt's **Always** grants the rules it shows rather than the whole category, and **Always in this project** saves them to the git-ignored personal file. `/permissions` and `switchback doctor` list every rule and where it came from
- **Permission modes** (#77): `default`, `acceptEdits`, `plan`, and `bypassPermissions`. In plan mode the model can't edit; it presents a plan with the new `exit_plan_mode` tool for you to approve. Switch with Shift+Tab or `/mode` in the TUI, the **Mode** button in VS Code, `--permission-mode`, or `permissions.defaultMode`. New protocol method `session.setMode`, event `mode.changed`, and method `permissions.list`
- TUI: **Ctrl+C clears the prompt** (a pasted chip included) instead of quitting. On an empty prompt it cancels the running turn; when idle, a second press within 2 seconds quits (#89)
- **Session picker** (#89): `/resume` with no argument and `switchback --resume` (`-r`) list saved sessions to filter and open; `switchback sessions [--json]` lists them for scripts
- `/copy tool` copies the last tool's output and `/copy all` the whole conversation as Markdown, in both clients from one implementation (`pickCopy` in `@switchback/client`) (#89)
- VS Code: Esc in an empty composer stops the running turn
- **Queue and interrupt** (#92): messages sent during a turn are queued by the engine and reach the model at its next step (or start the next turn), shown under the transcript until then; ↑ (TUI) or **Withdraw** (VS Code) takes one back. Esc with a message typed (TUI) or **Send now** (VS Code) stops the turn and sends it at once. `session.prompt` takes `delivery`, new `session.dequeue`, and `queue.updated` / `queue.delivered` events
- VS Code: a rounder composer, a round ↑ send button that becomes an ✕ (with a soft pulsing ring) while the model works, and rounded prompts, bubbles, and controls
- **Background shells** (#84): `bash` with `background: true` starts a dev server or watcher and returns; the new `bash_output` and `kill_shell` tools read and stop it (and come with `bash` in every agent's tools). `/shells` in both clients, a running count in the TUI status bar, protocol methods `shells.list` and `shells.kill`, and a `shell.updated` event. Background shells end with the engine
- `bash.timeoutMs` (default 2 minutes; a call may ask for up to 10), `bash.env`, and `bash.shell`. A command that times out says so and suggests the background (#84)
- Organizations can turn off `bypassPermissions` (`restrictions.allowBypassPermissions`) and keep only their own allow and ask rules (`restrictions.allowUserPermissionRules`)
- TUI: a **slash command menu** under the input while you type `/`, with the same commands and keys as VS Code's (Enter on a command that needs an argument waits for it)
- VS Code: a **slash command menu**. Type `/` or click the **/** button in the input's toolbar for every command, grouped and filtered as you type (↑/↓, Enter runs, Tab completes for arguments). The chat now runs the TUI's commands (`/new`, `/agent`, `/sessions`, `/compact`, `/usage`, `/receipt`, `/models`, `/roles`, `/review`, `/mcp`, `/subagents`, `/copy`, …) plus `/setup`, `/logs`, and `/restart`; before, it understood only `/agent`. Both clients take the list from `SLASH_COMMANDS` in `@switchback/client`, so the TUI's `/help` is built from it too
- VS Code: controls above the chat input: **Auto | Local | Remote**, the session's **Agent**, and **Start**, **Escalate**, and **Review** pills showing which models fill each role, each opening its picker (with **Save as Default**); the step the session is on is highlighted while it's up the ladder. The escalation prompt says **Escalate** / **Stay on the current model**, since a step can be any model
- Change roles during a session (#63): `/start`, `/escalate`, `/review ladder|with`, `/subagent-model`, `/roles [reset]`, and `/models` in the TUI, and **Choose Models for This Session** in VS Code. Changes apply to the session and its subagents; `--save` / **Save as Default** writes them to the user config; organization-enforced keys are refused. New protocol methods `session.roles` and `session.setRoles` and a `roles.updated` event. `route.decided` carries the ladder position, and both status lines show it (`step 1/2 qwen3-coder-480b, 2 more`). `switchback agents new` lists every configured model with its tier and role
- **Review ladder** (#61): `review.models` lists reviewers in order, any models, local or remote (each an alias or a chain of alternatives). The first reviews every change; if its findings still stand after one fix, the next takes over, up to `maxRounds` (now 3 by default). Left empty, the reviewers are the `routing.escalate` ladder. Any model's edits are reviewed now, not only a local model's, and a model never reviews its own work. Reviewers that are down or not allowed (remote off, private session, spent budget) are passed over for the next. **Breaking:** `review.model` became `review.models`
- `switchback self-update [version]` updates the CLI in place to the newest release, or to a given one, checked against the release's `SHA256SUMS`. `--check` only reports. A failed download never breaks the install, and it works on Windows, where a running .exe can't be overwritten (#56)
- Escalation ladder (#58): `routing.escalation.via` lists steps between the local chain and the remote chain, usually bigger local models, so escalation goes fast local → large local → remote, one step at a time. Stickiness keeps the session on the step it reached. Local steps never ask and aren't budgeted, and they also work in `local-only` mode and in private sessions. `switchback init` offers a bigger local model as an escalation step (`--local-escalation-model`) and any model as the automatic reviewer of local edits (`--reviewer remote|<local model>`). `switchback doctor` shows the ladder

### Changed
- **Breaking:** `switchback run --json` is now `--output events`; `--output json` prints a single result object
- **Open conventions only** (ADR 0016, supersedes 0005). **Breaking:** Switchback no longer reads another agent's setup: no `CLAUDE.md` (project instructions come from `AGENTS.md`), no `.claude/agents/` (agents live in `.switchback/agents/` or `~/.config/switchback/agents/`), and no `.mcp.json` (MCP servers go under `mcpServers` in a Switchback config). Size aliases are `large`, `medium`, and `small` instead of `opus`/`sonnet`/`haiku`; re-run `switchback init` or rename them in your config. Tool names in agent files and rules are Switchback's, matched case-insensitively
- TUI: a cleaner screen. A boxed header with the workspace and key hints, `●` rows for replies and tools (colored by state, with `⎿` under a failure), a spinner line with elapsed time and what's running, highlighted keys in permission and escalation prompts (the escalation prompt now says **escalate** / **stay on the current model**), and a tidier status bar
- VS Code: a redesigned chat. The input is a rounded composer that grows as you type, with a round send button that becomes **Stop** while a turn runs. Your messages appear as bubbles, routing lines show a local/remote dot, and code blocks, prompts, and notices are restyled. A new session opens with a short welcome. Every color still comes from the VS Code theme
- `switchback init` asks for models first (any number, local and hosted), then which model does what, with defaults filled in: the first local model starts, other local models come next on the ladder, then hosted models from cheapest to most expensive; review and the subagent model are one menu away (#62). Aliases come from model names (`coder:7b` → `coder-7b`) instead of `local-2`/`remote-3`. Unattended: `--start`, `--escalate` (repeatable; commas for alternatives), `--reviewers off|ladder|a,b`, and `--subagent-model` replace `--local-escalation-model` and `--reviewer`. `switchback doctor` shows reviewers and the subagent model
- **Role-based routing** (ADR 0015, #60). Models fill roles, and any model can fill any role: `routing.start` (where turns begin) and `routing.escalate` (an ordered ladder; a step is an alias or a chain of alternatives). Local vs. remote is now a property of the model: it decides cost, budgets, `ask` prompts, privacy, and `routing.allowRemote`, never which role a model can fill. So all-local, all-remote (cheap remote escalating to expensive remote), and mixed setups are the same config. `/local` and `/remote` pick the first model of that tier in role order. Outages fall back to the nearest step that's up (`routing.fallback: nearest|none`). `subagents.model` sets a default model for subagents, and the classifier can be any model. **Breaking:** `routing.local`, `routing.remote`, `routing.mode`, `escalation.via`, and `fallback.onLocalUnavailable`/`onRemoteUnavailable` are gone; old files fail with a message naming the replacement, and re-running `switchback init` rewrites them. An organization's remote-off restriction now sets `routing.allowRemote: false` and prunes roles whose models it removes
- "Remote review" is now "review of local edits" everywhere (the VS Code command is **Set Review of Local Edits**), since the reviewer can be a local model
- `switchback init --yes` without `--remote` lists every supported remote provider in its error

### Fixed
- Organization policy role aliases are optional when a member does not define the corresponding model (#71).
- OpenRouter (#54): structured `reasoning_details` (Claude thinking and Gemini thought signatures, encrypted OpenAI reasoning) are kept and sent back to the same model on tool-call turns, which those models need after a tool result. Server-side failures reported inside a stream are retryable, so the router falls back to the next model, and a stream that ends with `finish_reason: "error"` is a failure rather than an empty answer. `effort` goes out as OpenRouter's `reasoning.effort`

## [0.6.0] - 2026-10-01

### Added
- Windows installer: `irm https://switchback.harville.ai/install.ps1 | iex` (`scripts/install.ps1`, Windows PowerShell 5.1 and PowerShell 7). Like `install.sh` it verifies the release's `SHA256SUMS`, needs no administrator rights, and takes `-Version`, `-Dir`, and `-VSCode`; it adds `~\.local\bin` to the user PATH unless `-NoModifyPath`. Site consoles show the installer for the visitor's platform (#51)
- Use the terminal UI, the VS Code extension, or both (#51). The extension runs the `switchback` CLI when it's at least as new as its bundled engine, so both use one engine. For the shared workspace engine, the newest version wins: a newer client asks an older idle daemon to step aside (`daemon.retire`, a new protocol method), and an older client attaches to a newer daemon that speaks its protocol. When they can't share, both clients now say why instead of quietly splitting sessions. **Switchback: Install Terminal Command** installs the CLI from VS Code
- The VS Code extension is on the VS Code Marketplace as `isaiah-harville.switchback` (pre-release while Switchback is 0.x; Open VSX publishing is ready once its namespace is set up), with the right engine for each platform and a universal fallback that uses `switchback` from PATH. Publishing signs in with Microsoft Entra ID through GitHub OIDC, so no Marketplace token is stored, and can be re-run for any release tag (#48)
- One-line install for macOS and Linux: `curl -fsSL https://switchback.harville.ai/install.sh | sh` (`scripts/install.sh`). It picks the build for the machine (including Apple silicon under Rosetta), verifies it against the release's `SHA256SUMS`, installs to `~/.local/bin` without sudo or profile edits, and with `--vscode` also installs the VS Code extension
- Copy and paste in the TUI: pastes arrive whole through bracketed paste (a pasted newline never submits), with terminal colors and control characters stripped; big pastes collapse to a `[Pasted text #1 · 240 lines]` chip that expands on send; dragged-in workspace files become `@` mentions. `/copy [n]` copies the last reply or its nth code block as raw text, via OSC 52 (works over SSH and tmux) and the native clipboard
- Switchback sites (ADR 0010, #39): the hosted, multi-tenant control plane Harville Labs runs at switchback.harville.ai (`apps/site`). Each company has a site with seats and members (`operator`, `admin`, `member`); operators and admins invite by email, edit versioned, validated policy, see usage by member and model, sign out devices, choose members' telemetry, and read an audit log. Switchback managers (Harville Labs staff; ADR 0012) see every site, create sites, set seats, assign each site's operators, manage the manager list, and see telemetry across sites. Members connect with `switchback login --site <id>`; signed-in clients send telemetry to their site. Built with SvelteKit (Svelte 5) and Drizzle on Postgres only (CloudNativePG in production, a Postgres container locally and in CI; ADR 0011), with authentication by Better Auth (ADR 0013): emailed sign-in links through Cloudflare SMTP, invitations that hold seats, the device authorization grant for `switchback login` with tokens bound to one site, and per-site OIDC single sign-on (#47) with DNS domain verification, sessions that work only on their own site, and an optional "require SSO"; Harville Labs staff can sign in through their own identity provider. Deployed to the homelab cluster by Flux
- Privacy: `privacy.localOnlyPaths` pins a session to local models for good once content from a matching file enters it (reads, grep hits, edits, mentions, attachments, bash commands naming the path, subagent reports). A new router guard, `privacy`, overrides every other rule, including explicit remote requests. The mark lives in the transcript, is inherited by subagents, and blocks external runtimes and remote compaction. `privacy.secrets` (default `redact`) scans every remote request with secretlint and replaces credentials with placeholders in the outbound copy only (`block` keeps the turn local instead). A `secrets.redacted` event and `🔒` markers in both clients show what happened (#45)
- Savings receipt: `/receipt` (TUI), **Show Session Receipt** (VS Code), and the last line of `switchback run` show what a session and its subagents cost against running it all on the reference remote model. `usage.get` takes a `sessionId` and reports `referenceModel`; `usage.updated` and session summaries carry `savingsUsd`, shown in both status lines (part of #35)
- Draft locally, review remotely (#46): with `review.mode: auto` (or per prompt: `/review on`, **Set Remote Review of Local Edits**, `switchback run --review`), a turn in which a local model edited files ends with a review of the turn's diff by `review.model` (default: the first remote model; a bigger local model works too). A `revise` sends the findings back to the local model to fix, up to `review.maxRounds` reviews. The review is a routing decision (rule `review`), obeys local-only mode, org policy, budgets, privacy, and secret redaction, and a `review.completed` event shows the verdict and findings in both clients
- Opt-in anonymous telemetry (#35): off by default; `switchback telemetry status|on|off|preview`, and one question in `switchback init` (always saved to the user config; a project can turn it off, never on). Daily reports of counts, token totals, costs and savings, routing rules, catalog model IDs, and provider types, plus scrubbed crash reports; never prompts, code, paths, or user-chosen names (a test checks). `DO_NOT_TRACK`, `SWITCHBACK_TELEMETRY=0`, VS Code's telemetry setting, and org policy all force it off. Field-by-field in docs/telemetry.md

### Changed
- Harness is now **Switchback**. Everything was renamed with no fallbacks: the `switchback` command, `~/.config/switchback` and `.switchback/` (move an existing `~/.config/harness` there), `SWITCHBACK_*` environment variables, `@switchback/*` packages, the VS Code extension (`isaiah-harville.switchback`, settings and commands under `switchback.`), the repository (`Harville-Labs/switchback`), and sites at switchback.harville.ai. Releases before this one are named `harness-*`
- Switchback is open source under Apache-2.0, except `apps/site`, the hosted console, which stays proprietary (ADR 0014). Using Switchback on your own is free; companies pay for a site. Releases include `LICENSE`, `NOTICE`, and `THIRD-PARTY-NOTICES.txt` for every bundled package, and each `.vsix` carries its own copy
- Sites moved from `/s/<id>` to `/sites/<id>` on switchback.harville.ai, and `switchback login --site <id>` uses the new path. Older clients must sign in again with `switchback login --server https://switchback.harville.ai/sites/<id>`
- The site console uses the Harville Labs drafting style from harville.ai; the public Switchback page lives on harville.ai, and the console's `/` goes to your sites or to sign-in
- Organization sign-in follows the OAuth RFCs: `POST /v1/device/code` and one `POST /v1/token` endpoint (device code and refresh grants) taking form posts, instead of JSON at `/v1/device/token` and `/v1/token/refresh`. Switchback runs the grant with openid-client; the token response's `org` is now optional (docs/organizations.md)
- Savings are estimated conservatively: the part of a local call's prompt that the session's previous call already sent (within five minutes) is priced as a remote cache read, not at the full input price (part of #35)

### Fixed
- VS Code compared the shared engine against the extension's version, not the version of the binary it ran, so with the CLI or `switchback.executablePath` it waited 8 seconds on every start and then ran a separate engine (#51)

## [0.5.0] - 2026-09-28

### Added
- Subagent drill-down: the shared view keeps a nested view per subagent. VS Code rows expand to show a subagent's routes, tool calls, nested subagents, and report; the TUI shows running subagents' activity inline and adds `/subagents` and `/subagent <n>` (#18)
- MCP client support with the official SDK: stdio, streamable HTTP, and SSE servers under `mcpServers` (Claude Code's format; a project's `.mcp.json` is read too). Tools appear as `mcp__<server>__<tool>`, agents can list them, and a new `permissions.mcp` category (default `ask`) can be overridden per server. Project-defined servers start only after `switchback mcp trust`. `switchback mcp`, `/mcp`, `mcp.list`, and a doctor section show server state; orgs can set `allowUserMcpServers: false` (#21)
- Per-agent budgets: `budgetUsd` in agent frontmatter (or `subagents.budgetUsd`) caps remote spend per subagent invocation, including nested subagents. Over budget, the subagent continues locally (`agent-budget`), or stops and tells its parent why when there's no local model (#23)
- Background subagents: `task` with `background: true` returns at once; the report is appended to the parent later (next step if it's busy, a follow-up turn if an interactive session is idle). Headless runs and subagents wait for their background work; cancelling a session cancels it (#20)
- Worktree isolation: `isolation: worktree` (task call or agent file) runs a subagent in its own git worktree and branch. On success its changes are committed to `switchback/<id>` and the parent gets the branch and diff; on failure the worktree is kept (#19)
- Providers: Claude Platform on AWS (`anthropic-aws`, with server-side refusal fallbacks) and Microsoft Foundry (`foundry`), on the shared Claude adapter; both in `switchback init` and `doctor` (part of #24)
- Google Gemini (`type: gemini`, Gemini API or Vertex AI) via `@google/genai`: thought signatures replayed verbatim to the same model, thinking levels and budgets from `effort`, safety stops as refusals, and Gemini 3.1 Pro / 3.8 Flash / 2.5 Flash in the catalog and `switchback init` (#24)
- `switchback agents new`: an interview (with flags for scripted use) that writes a validated agent file, optionally with a system prompt drafted by your model; `switchback agents` lists agents, and new or edited agent files are picked up without a restart (#25)
- External agent runtimes as subagents (ADR 0009), starting with Claude Code through the Claude Agent SDK: `runtime: <name>` in an agent file. Its tool calls go through the Switchback permission policy, its progress appears in the subagent tree, it obeys routing and budgets like any remote call, and its reported cost is recorded under rule `runtime` (#22)
- OpenAI Responses API (`api: "responses"` on an `openai` provider): reasoning is kept between tool calls as encrypted items (`store: false`) and replayed only to the model that produced it (part of #24)

## [0.4.0] - 2026-09-27

### Added
- Several providers at once: `routing.local` and `routing.remote` take ordered lists of model aliases from any mix of providers, including several local servers. The router uses the first reachable model whose window fits, so a big prompt moves to a bigger local model (`context-fit`) and a down server hands over to the next (`fallback`) before anything goes remote. `switchback init` adds more local models and fallback remote providers; `--local-model` and `--remote` repeat
- Append-only context compaction ([ADR 0008](docs/adr/0008-append-only-compaction.md)): long sessions are summarized into a marker, by a local model when possible, so they keep fitting the local window; the full transcript is kept. `session.compact`, `/compact`, and the VS Code "Compact Conversation" command compact on request; `context.compacted` reports it (#16)
- Refusal handling for every provider: a remote refusal is retried on the next model in `routing.remote` (`refusal-fallback`), and the refused output is discarded. The first-party Anthropic API also gets server-side `fallbacks: "default"`, with the answering model billed and reported (#14)
- Optional pre-routing classifier (`routing.classifier`): a small local model rates each new prompt, and hard ones start remote under the `classifier` rule, following `escalation.policy`. Off by default, local-only, skipped on timeout. On the labeled set, qwen3:1.7b scored precision 1.00 / recall 0.90 (#12)
- Escalation prompts show an estimated cost (`≈ $0.04`) in the TUI and VS Code; `escalation.requested` carries `estimatedCostUsd` (#13)
- Routing analytics: the ledger records each call's routing rule and agent; `switchback usage --period today|week|month --by rule|agent|model`; `/usage` shows the week with a breakdown; the remote cache hit rate is reported (#17)
- Accurate token counts: a BPE tokenizer, and near the local threshold the local server's own `/tokenize` (llama.cpp, vLLM); `route.decided` reports `inputTokens` (#11)
- Prompt-cache verification: a test guards the byte-stable request prefix, and a warning is logged once per session when a follow-up remote call misses the cache (#15)
- `effort: "none"` turns thinking off on every provider
- A declined escalation is reported as `escalation-declined`

### Changed
- OpenAI-compatible providers (OpenAI, DeepSeek, Ollama, vLLM, llama.cpp, LM Studio, hosted gateways) use the official `openai` SDK: typed errors, backoff on 429/5xx for hosted APIs, fail-fast for local servers. `OPENAI_*` environment variables are never picked up implicitly, so a key can't leak to another server
- Config files are parsed with `jsonc-parser` (trailing commas allowed, errors give line and column), and `switchback init` edits existing files in place, keeping comments and formatting
- `switchback init`: the openai-compatible remote's window is now `--remote-context-window`; `--context-window` pairs with each `--local-model`
- Local servers receive at most `reasoning_effort: "high"` (Ollama rejects `xhigh`/`max`)
- TUI `@` file completion uses fzf's matching algorithm

### Fixed
- `mode: local-only` no longer falls back to a remote model when the local server is down
- TUI prompt editing no longer splits emoji, flags, or combining accents
- VS Code's usage notification says "last 7 days", matching the numbers it shows

## [0.3.0] - 2026-09-27

### Added
- VS Code: platform-specific `.vsix` packages bundle the engine; Marketplace/Open VSX publishing when tokens are configured
- VS Code: Markdown rendering in chat (raw HTML escaped, http(s)/mailto links only, DOMPurify as a second layer) with Copy / Insert-at-cursor on code blocks; session history picker
- VS Code integration tests running inside a real VS Code instance in CI
- VS Code: review proposed edits in the diff editor with Accept / Reject in the editor title; protocol adds `proposed` (full new file) to `permission.requested` and `permission.resolved` / `escalation.resolved` events so every client clears answered prompts
- Prompt attachments in the protocol (`file` ranges read by the engine, labeled `text`); VS Code chips attach the selection, active file, or its problems
- Shared engine daemon (`switchback serve --socket`): the TUI and VS Code attach to one engine per workspace by default and share live sessions; token-authenticated socket, version-checked, idle exit, automatic fallback to a private engine
- Mock provider can script a tool call (`mock:tool {json}`) for demos and client development

### Fixed
- VS Code: activation hung until the user dismissed the "no local model" or "could not start" notification
- `shutdown` closed the connection before its reply was written

## [0.2.0] - 2026-09-27

### Added
- Organization policy: `switchback login` (device flow or token), `logout`, `whoami`. An org server pushes default models (e.g. company GPU servers), enforced settings, and restrictions (remote off, provider allowlists, org-only providers, spend caps), applied live with a `config.updated` event; daily usage aggregates are reported. Reference server included; see docs/organizations.md
- First-class OpenAI and DeepSeek providers alongside Anthropic: OpenAI uses `max_completion_tokens` and `reasoning_effort`; DeepSeek gets thinking mode and same-model `reasoning_content` replay; cached tokens are priced correctly for both
- Model catalog (IDs, tiers, context windows, list prices) shared by setup and pricing; ADR 0006 on provider neutrality
- `switchback init` setup wizard: detects Ollama, LM Studio, llama.cpp, and vLLM, reads tool support and effective context size, configures Anthropic, Bedrock, or Vertex, escalation policy, and budgets; fully scriptable with flags
- `switchback config path|show|schema|edit`
- First-run setup offer in the TUI; "Set Up Models" in VS Code
- Config JSON Schema with validation and autocomplete in VS Code
- Session resume: `switchback --continue`, `--session <id>`, `/sessions`, `/resume`; shared `fromTranscript` view rebuild
- `models.<alias>.contextWindow` is optional for local models: the engine asks the server what it loads, and `doctor` reports the value and its source
- TUI prompt editor: multi-line (Option/Alt+Enter, Ctrl+J, or trailing `\`), per-workspace history on ↑/↓, and `@file` mentions with fuzzy completion; the engine attaches mentioned files (up to 10, 200 KB each) for every client
- TUI renders finished assistant messages as Markdown (headings, lists, tables, highlighted code), wrapped to the terminal width; streaming text stays plain
- `grep` uses ripgrep when installed (honors `.gitignore`, ~3x faster on a 20k-file tree), falling back to the JS search for patterns rg can't parse (lookaround) or when rg is absent
- Live test suite (`bun run test:live`) and nightly workflow: the same read/edit/subagent/escalation scenarios against a real local model and every hosted provider with credentials
- Release workflow: tag `v*` builds 5 platform binaries plus the `.vsix`, with checksums and changelog notes; `scripts/release.ts` keeps versions in sync
- Diff previews in edit/write permission prompts (TUI and VS Code); doomed edits fail without prompting

### Changed
- **Breaking:** no default providers or models at all. Switchback doesn't pick a vendor; `switchback init` asks, offering OpenAI, Anthropic, DeepSeek, Bedrock, Vertex, and any OpenAI-compatible API on equal terms
- `opus`/`sonnet`/`haiku` agent aliases mean large/medium/small on the chosen provider
- **Breaking:** no default local provider or model. Configure one with `switchback init`. Without one, turns route remotely and local-only requests are refused with guidance.
- Agents pinned to `local` fall back to normal routing when no local model is configured
- Requires Bun 1.4+

### Fixed
- An "allow always" permission grant could override a `deny` setting; `deny` now always wins
- **Security:** on Windows, file tools accepted paths outside the workspace (the escape check assumed `/` separators)
- The `bash` tool now works on Windows: Git Bash when installed (never the WSL launcher), otherwise PowerShell, otherwise cmd; the system prompt names the shell
- Sessions were kept in memory only in the CLI; they now persist to the data directory
- Session titles were lost on disk (the header was written before the first prompt)

## [0.1.0] - 2026-09-26

### Added
- Engine with JSON-RPC protocol over stdio and in-process transports
- Router: user override, mode, agent pins, context overflow, stickiness, quality-signal escalation (`auto`/`ask`/`off`), budgets, and cross-tier fallback
- Providers: OpenAI-compatible (Ollama, llama.cpp, LM Studio, vLLM), Anthropic API, Amazon Bedrock, Vertex AI, and mock
- Tools: read, glob, grep, edit, write, bash, task, with workspace confinement and permission policy
- Subagents with per-agent routing, parallel execution, and depth limits; Claude Code agent file compatibility
- Usage ledger with per-tier cost, budgets, and estimated savings
- Terminal UI, headless `run`, `serve --stdio`, `doctor`, `usage`
- VS Code extension with chat view, routing control, status bar, and permission prompts
