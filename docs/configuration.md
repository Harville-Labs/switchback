# Configuration reference

## Files and precedence

Layers deep-merge in this order, with later layers winning:

1. Built-in defaults (below)
2. Organization policy `defaults`, when signed in ([organizations.md](organizations.md))
3. `~/.switchback/config.json` (user; `SWITCHBACK_HOME` moves the whole directory)
4. `.switchback/config.json` in the workspace (project)
5. Organization policy `enforced`, then its `restrictions`
6. `--mock` (any command) then swaps every provider for a scripted mock

Files are JSONC: `//` and `/* */` comments and trailing commas are allowed. Any string of the form `{env:NAME}` is replaced with that environment variable, so secrets stay out of files. `switchback doctor` shows which files were loaded.

Next to each config file, `agents/`, `commands/`, and `skills/` folders hold [agents](subagents.md), [custom commands, and skills](commands-and-skills.md). Standing instructions go in `AGENTS.md`: the workspace's, and `~/.switchback/AGENTS.md` for every project ([AGENTS.md](commands-and-skills.md#agentsmd)).

`SWITCHBACK_HOME=<dir>` relocates config and data (`<dir>/config.json`, `<dir>/AGENTS.md`, `<dir>/agents/`, `<dir>/commands/`, `<dir>/skills/`, `<dir>/data/`). It's useful for tests and for isolating experiments.

## Setting up

```sh
switchback init              # interactive: detect local servers, choose models, budgets
switchback init --yes --local-model <name> --remote anthropic   # unattended
switchback init --yes --no-local --remote openrouter --remote-model qwen/qwen3-coder
switchback init --yes --no-local --remote azure-openai --resource acme-ai \
  --remote-model gpt-6-sol --deployment prod-gpt --azure-auth entra
switchback config path       # where config files live and which exist
switchback config show       # effective merged config (secrets redacted)
switchback config edit       # open the user config in $EDITOR (--scope project for the project file)
switchback config schema     # JSON Schema for editor validation
```

`switchback init` asks for your models in two parts:

1. **Local endpoints.** "Do you have any local model endpoints?" Enter each server's URL; servers already running here (Ollama on 11434, LM Studio on 1234, llama.cpp on 8080, vLLM on 8000, and others) are found first and offered as the answer. Each endpoint's models come up as a checklist (arrow keys, space to pick, Enter when done), with tool-calling support and the context size the server loads; the context size is asked only when the server can't say. Then "Any more local endpoints?"
2. **Remote providers.** "Set up any remote providers?" Pick a provider, answer its setup (model, region, resource, ...), then "Any additional remote providers?" Pick the same provider again for a second model from it.

Then it asks which model does what, and writes a config layer, to the user config unless you pass `--scope project`. It edits an existing file in place, keeping unrelated keys, comments, and formatting, and saves the previous version as `config.json.bak`. Every prompt has a flag; see `switchback --help`.

Machine-specific settings (which local server and model) belong in the user config. Team-shared settings (permissions, agents, budgets) belong in the project config, and your own settings for one project in `.switchback/config.local.json`.

The VS Code extension validates both files against the schema and offers autocomplete. Other editors can use the output of `switchback config schema`.

## Built-in defaults

There are **no default providers or models**, local or remote. Switchback doesn't choose a vendor for you; `switchback init` writes the ones you pick. With nothing configured, `doctor` reports what's missing and `switchback` offers setup.

Models fill roles ([routing.md](routing.md)): `routing.start` is where turns begin and `routing.escalate` is the ladder above it. Any model can fill any role, so all-local, all-remote, and mixed setups are the same config with different models:

- With no local model in a role, turns run remote and the route line says so. Agents pinned to `local` (such as `explore`) route normally instead of failing; `--route local` and `/local` are refused with a pointer to `switchback init`.
- With no remote model in a role (or `routing.allowRemote: false`), nothing is ever billed; escalation still climbs through local steps.

## Several providers at once

Any number of providers can be configured together, including several local servers: Ollama on your laptop, vLLM on a GPU box, and your organization's servers side by side with OpenAI, Anthropic, and DeepSeek. Each model gets an alias, `routing.local` and `routing.remote` list aliases in order of preference, and agents can pin any alias (`model: gpu-coder`).

```jsonc
{
  "providers": {
    "ollama":   { "type": "openai-compatible", "baseUrl": "http://localhost:11434/v1" },
    "gpu":      { "type": "openai-compatible", "baseUrl": "http://gpu-box:8000/v1" },
    "openai":   { "type": "openai" },
    "deepseek": { "type": "deepseek" }
  },
  "models": {
    "laptop":  { "provider": "ollama", "model": "qwen3:8b", "contextWindow": 32768 },
    "big":     { "provider": "gpu", "model": "qwen3-coder-30b", "contextWindow": 131072 },
    "sol":     { "provider": "openai", "model": "gpt-6-sol" },
    "ds":      { "provider": "deepseek", "model": "deepseek-v4-pro", "effort": "high" }
  },
  "routing": { "start": ["laptop"], "escalate": ["big", ["sol", "ds"]] }
}
```

Turns start on the laptop; an escalation goes to the GPU box first, then to OpenAI, with DeepSeek as the fallback if OpenAI is down. `switchback init` builds this for you: pick any number of models (local servers it detects, any hosted provider), then decide which model does what. Aliases come from model names (`qwen3-coder:30b` becomes `qwen3-coder-30b`). How the router picks is in [routing.md](routing.md).

A list inside a role is a chain of alternatives (the first that's up and fits); each entry of `escalate` is one step. Any alias can also be the reviewer (`review.model`, see [review.md](review.md)), the default for subagents (`subagents.model`), or an agent's model (`model: big`), local or remote.

## Keys

### `providers.<id>`

| `type` | Fields |
|---|---|
| `openai-compatible` | `baseUrl` (required), `apiKey`, `tier` (`local`\|`remote`, default `local`), `headers` |
| `openai` | `apiKey` (default `$OPENAI_API_KEY`), `baseUrl` (default `https://api.openai.com/v1`), `organization`, `api` (`chat` \| `responses`, default `chat`) |
| `deepseek` | `apiKey` (default `$DEEPSEEK_API_KEY`), `baseUrl` (default `https://api.deepseek.com`) |
| `anthropic` | `apiKey`, `baseUrl`, `refusalFallback` (`server` \| `off`, default `server`; see [routing.md](routing.md#refusals)) |
| `bedrock` | `region`, `profile`, `eagerToolInputStreaming` (default `false`) |
| `vertex` | `projectId` (required), `region` (default `global`) |
| `gemini` | `apiKey` (default `$GEMINI_API_KEY`), or `project` + `location` (default `global`) for Vertex AI |
| `anthropic-aws` | `region`, `workspaceId`, `profile`, `refusalFallback` (Claude Platform on AWS) |
| `foundry` | `resource` or `baseUrl`, `apiKey` (default `$ANTHROPIC_FOUNDRY_API_KEY`) (Microsoft Foundry) |
| `azure-openai` | `resource` or `baseUrl` (one is required), `apiKey` (default `$AZURE_OPENAI_API_KEY`), `auth` (`key` \| `entra`, default `key`), `api` (`responses` \| `chat`, default `responses`); models are deployment names |
| `claude-code` | `executable` (default `claude` on PATH), `billing` (`subscription` \| `api`, default `subscription`). Claude Code as you're signed in to it; see [providers.md](providers.md#claude-code-and-codex-with-your-own-sign-in) |
| `codex` | `executable` (default `codex` on PATH), `billing`, `sandbox` (`read-only` \| `workspace-write`, default `workspace-write`), `network` (default `false`) |
| `mock` | `tier` |

### `models.<alias>`

| Key | Default | |
|---|---|---|
| `provider` | required | A key of `providers` |
| `model` | required | The provider's model ID |
| `contextWindow` | detected / catalog | Tokens the model accepts; used by the context-overflow rule. Setup fills it from the catalog for hosted models. For local models it can be omitted, and the engine asks the server (Ollama, LM Studio, llama.cpp, vLLM), sending the provider's `apiKey`. A proxy in front of the server (LiteLLM, a vLLM router) usually can't say; then it assumes 8,192 and `doctor` flags it. |
| `maxOutputTokens` | 16000 | `max_tokens` per call, lowered to what the context window (configured or detected) has left after the prompt |
| `vision` | catalog / `false` | Whether the model can read images. Known for catalog models; set it for local or other models that can (Qwen-VL, Gemma 3, Llama 3.2 Vision, and the like). Without it, images are replaced with a note for this model. See [routing.md](routing.md#images) |
| `effort` | unset | `none`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`. Sent as `output_config.effort` (Anthropic), `reasoning_effort` (OpenAI and local servers, capped at `high` locally), or thinking plus `reasoning_effort` (DeepSeek, where it turns thinking on). `none` turns thinking off everywhere: no thinking block for Claude, DeepSeek's non-thinking mode, and `reasoning_effort: "none"` plus `chat_template_kwargs.enable_thinking: false` for local servers. |
| `price` | built-in table | `{ input, output, cacheRead?, cacheWrite? }` in USD per million tokens |

### `routing`

See [routing.md](routing.md#configuration-reference).

### `permissions`

| Key | Default | Governs |
|---|---|---|
| `read` | `allow` | `read`, `glob`, `grep` |
| `edit` | `ask` | `write`, `edit` |
| `bash` | `ask` | `bash` |
| `web` | `ask` | `webfetch`, `websearch` |
| `mcp` | `ask` | Tools from MCP servers (a server's own `permission` can change it, except that `deny` here always wins) |
| `defaultMode` | `default` | The mode new sessions start in: `default`, `acceptEdits`, `plan`, or `bypassPermissions` |
| `outsideWorkspace` | `ask` | Files outside the workspace: with `ask`, reads follow `read` and edits ask (allow rules that name a folder open it ahead of time); `deny` keeps file tools in the workspace, reads included. See [permissions.md](permissions.md#outside-the-workspace) |
| `allow`, `ask`, `deny` | `[]` | Rules such as `bash(git status:*)`, `read(.env)`, `edit(src/**)`, `mcp__github`. Lists from every layer add up |

The levels are `allow`, `ask`, and `deny`. See [permissions.md](permissions.md) for the order rules and modes are applied in and the full rule syntax.

Personal settings for one project go in `.switchback/config.local.json`. It's read after `.switchback/config.json`, and Switchback writes it when you answer a prompt with **Always in this project**, adding it to `.switchback/.gitignore`.

### `web`

| Key | Default | Meaning |
|---|---|---|
| `search` | unset | The `websearch` tool's backend: `{ "provider": "brave", "apiKey": "{env:BRAVE_API_KEY}" }`, `{ "provider": "tavily", "apiKey": "{env:TAVILY_API_KEY}" }`, or `{ "provider": "searxng", "baseUrl": "https://search.example.com" }` (a self-hosted SearXNG with the JSON format enabled). Without one, `websearch` tells the model it isn't set up |
| `maxChars` | `100000` | Most characters of a fetched page returned to the model |
| `timeoutMs` | `30000` | How long a fetch or search may take |

`webfetch` reads a page as Markdown (HTML is converted; other text is returned as is; binary content is refused). It follows redirects on the same host and reports one to another host instead of following it. Both tools are in the `web` permission category (`permissions.web`, default `ask`), and neither runs in a session holding private content, since a URL or query could carry it out.

### `bash`

| Key | Default | Meaning |
|---|---|---|
| `timeoutMs` | `120000` | How long a foreground command may run before it's killed. A call may ask for up to 10 minutes; longer-running commands belong in the background |
| `env` | `{}` | Added to every command's environment. Values may be `{env:NAME}` |
| `shell` | detected | A POSIX shell to run commands with instead of the detected one, such as `/bin/zsh`; run as `<shell> -c <command>` |
| `sandbox.mode` | `auto` | `auto` (on where supported), `on` (refuse to run commands without it), or `off`. See [permissions.md](permissions.md#sandbox) |
| `sandbox.network` | `all` | `all`, `none`, or the hosts commands may reach (`*.github.com`) |
| `sandbox.allowWrite` | `[]` | Writable besides the workspace, temp directories, and package caches (`~` works) |
| `sandbox.denyRead` | credentials (`~/.ssh`, `~/.aws`, ...) | Never readable; replaces the default list |
| `sandbox.denyWrite` | `[]` | Never writable, even inside the workspace |
| `sandbox.allowUnsandboxed` | `true` | Whether a command may ask to run outside the sandbox (you're always asked) |

A command started with `background: true` keeps running after the call returns: dev servers, watchers, long builds. The model reads its new output with `bash_output` and stops it with `kill_shell`; you see them with `/shells` and stop one with `/shells kill <id>`. Background shells end when the engine does. Starting one is a normal `bash` call for permissions; reading and stopping it asks nothing more.

### `hooks`

Commands to run on session events. Hooks from every layer add up; a project's wait for `switchback hooks trust`. See [hooks.md](hooks.md).

### `mcpServers.<name>`

Tools from [MCP](https://modelcontextprotocol.io) servers, available to agents as `mcp__<name>__<tool>`. Servers use the `mcpServers` shape most MCP clients share, so a definition can be copied from another tool's config. Switchback reads them only from its own config files, not from `.mcp.json` or another tool's settings.

```jsonc
"mcpServers": {
  "github": {                                   // stdio: Switchback starts the process
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
  },
  "tickets": {                                  // streamable HTTP (or "type": "sse")
    "url": "https://mcp.example.com/tickets",
    "headers": { "Authorization": "Bearer {env:TICKETS_TOKEN}" },
    "permission": "allow"                       // read-only server: don't ask
  }
}
```

| Key | Default | |
|---|---|---|
| `command`, `args`, `env`, `cwd` | | stdio servers. The process gets a minimal environment plus `env`, not your whole shell environment, and runs in the workspace unless `cwd` is set |
| `url`, `headers`, `type` | `type: http` | Remote servers over streamable HTTP; `type: "sse"` for older servers |
| `permission` | `permissions.mcp` | `allow`, `ask`, or `deny` for this server's tools |
| `enabled` | `true` | Keep a definition without starting it |
| `timeoutMs` | 60000 | Per tool call, resource read, or prompt |

**Resources and prompts.** Besides tools, a server can offer:

- **Resources**: type `@<server>:<uri>` in a prompt (`@docs:docs://api/auth`) to attach one, as `@path` attaches a file; the TUI's `@` completion lists them. Text comes in as text and images as images. The model can read them too, with `mcp__<server>__read_resource`, whose description lists the server's resources (that call follows the server's `permission`, like its tools).
- **Prompts**: they're slash commands named `<server>:<prompt>` (`/github:review-pr 123`), listed under **Custom** in both clients' menus. Words after the name fill the prompt's arguments in order, and the last argument takes the rest of the line.

`/mcp` lists each server's resources and prompts. A server's tool results can include images, which reach models with vision.

**Project servers need trust.** A server defined in a project's `.switchback/config.json` runs a command from the repository, so it doesn't start until you approve it with `switchback mcp trust` (or `switchback mcp trust <name>`). Approval is per workspace and per definition: if the repository changes the server's command, it needs approval again. The same applies when a project redefines a server from your user config. `switchback mcp` and `switchback doctor` show every server's state and tool count.

### `privacy`

| Key | Default | |
|---|---|---|
| `localOnlyPaths` | `[]` | Globs, relative to the workspace, or anywhere with `~/` and `//` (`~/customers/`). Once content from a matching file enters a session, the session stays on local models for good. A pattern without a slash matches by file name anywhere (`*.pem`, `.env*`) |
| `secrets` | `redact` | Credentials in what's about to be sent to a remote model: `redact` replaces them with placeholders in the outbound copy, `block` keeps the turn local, `off` sends them unchanged |

See [privacy.md](privacy.md) for what's detected and the limits.

### `review`

| Key | Default | |
|---|---|---|
| `mode` | `off` | `auto`: after a turn in which a model edited files, a reviewer checks the diff and the writing model fixes what it finds. A prompt's `review` flag overrides it |
| `models` | the `routing.escalate` ladder | Reviewers in order, any models; each entry an alias or a chain of alternatives. When a reviewer's findings still stand after a fix, the next takes over |
| `maxRounds` | 3 | Reviews per prompt, across all reviewers (1 to 6) |

See [review.md](review.md).

### `notifications`

How clients get your attention: when a permission, plan, or escalation prompt is waiting, and when a long turn finishes.

| Key | Default | |
|---|---|---|
| `mode` | `system` | `system`: the TUI asks the terminal for a desktop notification (iTerm2, WezTerm, Ghostty, kitty, foot, rxvt), and rings the bell in other terminals and inside tmux. `bell`: the terminal bell. `off`: nothing. VS Code shows its own notification unless this is `off` |
| `afterSeconds` | `30` | Notify when a turn that ran at least this long finishes (cancelled turns and subagents' turns don't count); `0` turns that off |

VS Code notifies only when you can't see the chat: its window isn't focused, or the chat view is closed. The [`Notification` hook](hooks.md) runs whatever this is set to, for your own notifier.

### `telemetry`

| Key | Default | |
|---|---|---|
| `enabled` | `false` | Anonymous daily usage statistics. Set with `switchback telemetry on\|off`; a project config can turn it off but not on. See [telemetry.md](telemetry.md) |
| `endpoint` | `https://switchback.harville.ai/api/telemetry/v1` | Where reports are sent |

### Other keys

| Key | Default | |
|---|---|---|
| `defaultAgent` | `build` | Agent for new sessions |
| `subagents.maxConcurrent` | 4 | Concurrent subagents per depth |
| `subagents.maxDepth` | 2 | Maximum nesting |
| `runtimes.<name>` | none | External agent runtimes agents can use with `runtime: <name>`: `claude-agent-sdk` (`model`, `maxTurns`, `executable`), `claude-managed-agents` (`agent`, `environment`, `model`, `apiKey`), `codex` (`model`, `sandbox`, `network`, `effort`, `executable`, `apiKey`), or `bedrock-agentcore` (`arn`, `qualifier`, `region`, `model`). See [subagents.md](subagents.md#external-runtimes) |
| `subagents.budgetUsd` | none | Default remote spend per subagent invocation; an agent's `budgetUsd` overrides it |
| `subagents.model` | none | Model alias for subagents whose agent doesn't pin a model or tier; otherwise they route like any turn |
| `maxStepsPerTurn` | 50 | Model calls per user prompt before stopping |
| `compaction.enabled` | `true` | Summarize older history automatically when the prompt gets large ([ADR 0008](adr/0008-append-only-compaction.md)) |
| `compaction.threshold` | 0.7 | Fraction of the largest local context window (the remote window when there's no local model) that triggers it |
| `compaction.keepRecent` | 0.25 | Fraction of that window kept verbatim at the end of the conversation |

## Environment variables

| Variable | Effect |
|---|---|
| `SWITCHBACK_HOME` | Relocate all config and data |
| `SWITCHBACK_ORG_SERVER`, `SWITCHBACK_ORG_TOKEN` | Organization sign-in without `switchback login` (CI, managed installs) |
| `DO_NOT_TRACK=1`, `SWITCHBACK_TELEMETRY=0` | Telemetry off, whatever the config says |
| `OPENAI_API_KEY` | OpenAI credentials |
| `DEEPSEEK_API_KEY` | DeepSeek credentials |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE` | Anthropic credentials (SDK chain) |
| `AWS_REGION`, `AWS_PROFILE`, ... | Bedrock credentials (AWS chain) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vertex credentials (ADC) |

Bash tool subprocesses get `SWITCHBACK=1` so scripts can detect they're running under the agent.
