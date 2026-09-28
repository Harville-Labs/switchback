# Configuration reference

## Files and precedence

Layers deep-merge in this order, with later layers winning:

1. Built-in defaults (below)
2. Organization policy `defaults`, when signed in ([organizations.md](organizations.md))
3. `~/.config/harness/config.json` (user; respects `XDG_CONFIG_HOME`)
4. `.harness/config.json` in the workspace (project)
5. Organization policy `enforced`, then its `restrictions`
6. `--mock` (any command) then swaps every provider for a scripted mock

Files are JSONC: `//` and `/* */` comments and trailing commas are allowed. Any string of the form `{env:NAME}` is replaced with that environment variable, so secrets stay out of files. `harness doctor` shows which files were loaded.

`HARNESS_HOME=<dir>` relocates config and data (`<dir>/config.json`, `<dir>/agents/`, `<dir>/data/`). It's useful for tests and for isolating experiments.

## Setting up

```sh
harness init              # interactive: detect local servers, choose models, budgets
harness init --yes --local-model <name> --remote anthropic   # unattended
harness config path       # where config files live and which exist
harness config show       # effective merged config (secrets redacted)
harness config edit       # open the user config in $EDITOR (--scope project for the project file)
harness config schema     # JSON Schema for editor validation
```

`harness init` probes Ollama (11434), LM Studio (1234), llama.cpp (8080), and vLLM (8000), lists their models with tool-calling support and the context size each server actually loads, and writes a config layer. It edits an existing file in place, keeping unrelated keys, comments, and formatting, and saves the previous version as `config.json.bak`. Every prompt has a flag; see `harness --help`.

Machine-specific settings (which local server and model) belong in the user config. Team-shared settings (permissions, agents, budgets) belong in the project config.

The VS Code extension validates both files against the schema and offers autocomplete. Other editors can use the output of `harness config schema`.

## Built-in defaults

There are **no default providers or models**, local or remote. Harness doesn't choose a vendor for you; `harness init` writes the ones you pick. With nothing configured, `doctor` reports what's missing and `harness` offers setup.

If only one tier is configured:

- With no local model, `auto` routing sends turns remote and the route line says so. Agents pinned to `local` (such as `explore`) route normally instead of failing. `--route local`, `/local`, and `mode: local-only` are refused with a pointer to `harness init`.
- With no remote model, turns stay local and escalation is unavailable.

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
  "routing": { "local": ["laptop", "big"], "remote": ["sol", "ds"] }
}
```

`harness init` builds this for you: after the first local model it offers to add more (from any detected server), and after the first remote provider it offers fallbacks. Unattended, repeat `--local-model` and `--remote`. How the router picks within a list is in [routing.md](routing.md).

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
| `mock` | `tier` |

### `models.<alias>`

| Key | Default | |
|---|---|---|
| `provider` | required | A key of `providers` |
| `model` | required | The provider's model ID |
| `contextWindow` | detected / catalog | Tokens the model accepts; used by the context-overflow rule. Setup fills it from the catalog for hosted models. For local models it can be omitted, and the engine asks the server (Ollama, LM Studio, llama.cpp, vLLM). If the server can't say, it assumes 8,192 and `doctor` flags it. |
| `maxOutputTokens` | 16000 | `max_tokens` per call |
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
| `mcp` | `ask` | Tools from MCP servers (a server's own `permission` can change it, except that `deny` here always wins) |

Values are `allow`, `ask`, and `deny`. See [permissions.md](permissions.md).

### `mcpServers.<name>`

Tools from [MCP](https://modelcontextprotocol.io) servers, available to agents as `mcp__<name>__<tool>`. The format is the same as Claude Code's `.mcp.json`, and a project's `.mcp.json` is read too.

```jsonc
"mcpServers": {
  "github": {                                   // stdio: Harness starts the process
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
| `timeoutMs` | 60000 | Per tool call |

**Project servers need trust.** A server defined in a project's `.harness/config.json` or `.mcp.json` runs a command from the repository, so it doesn't start until you approve it with `harness mcp trust` (or `harness mcp trust <name>`). Approval is per workspace and per definition: if the repository changes the server's command, it needs approval again. The same applies when a project redefines a server from your user config. `harness mcp` and `harness doctor` show every server's state and tool count.

### `privacy`

| Key | Default | |
|---|---|---|
| `localOnlyPaths` | `[]` | Globs, relative to the workspace. Once content from a matching file enters a session, the session stays on local models for good. A pattern without a slash matches by file name anywhere (`*.pem`, `.env*`) |
| `secrets` | `redact` | Credentials in what's about to be sent to a remote model: `redact` replaces them with placeholders in the outbound copy, `block` keeps the turn local, `off` sends them unchanged |

See [privacy.md](privacy.md) for what's detected and the limits.

### `telemetry`

| Key | Default | |
|---|---|---|
| `enabled` | `false` | Anonymous daily usage statistics. Set with `harness telemetry on\|off`; a project config can turn it off but not on. See [telemetry.md](telemetry.md) |
| `endpoint` | `https://harness.harville.ai/api/telemetry/v1` | Where reports are sent |

### Other keys

| Key | Default | |
|---|---|---|
| `defaultAgent` | `build` | Agent for new sessions |
| `subagents.maxConcurrent` | 4 | Concurrent subagents per depth |
| `subagents.maxDepth` | 2 | Maximum nesting |
| `runtimes.<name>` | none | External agent runtimes agents can use with `runtime: <name>`. `type: "claude-agent-sdk"` with optional `model`, `maxTurns`, `executable`. See [subagents.md](subagents.md#external-runtimes) |
| `subagents.budgetUsd` | none | Default remote spend per subagent invocation; an agent's `budgetUsd` overrides it |
| `maxStepsPerTurn` | 50 | Model calls per user prompt before stopping |
| `compaction.enabled` | `true` | Summarize older history automatically when the prompt gets large ([ADR 0008](adr/0008-append-only-compaction.md)) |
| `compaction.threshold` | 0.7 | Fraction of the largest local context window (the remote window when there's no local model) that triggers it |
| `compaction.keepRecent` | 0.25 | Fraction of that window kept verbatim at the end of the conversation |

## Environment variables

| Variable | Effect |
|---|---|
| `HARNESS_HOME` | Relocate all config and data |
| `HARNESS_ORG_SERVER`, `HARNESS_ORG_TOKEN` | Organization sign-in without `harness login` (CI, managed installs) |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Standard base directories |
| `DO_NOT_TRACK=1`, `HARNESS_TELEMETRY=0` | Telemetry off, whatever the config says |
| `OPENAI_API_KEY` | OpenAI credentials |
| `DEEPSEEK_API_KEY` | DeepSeek credentials |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE` | Anthropic credentials (SDK chain) |
| `AWS_REGION`, `AWS_PROFILE`, ... | Bedrock credentials (AWS chain) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vertex credentials (ADC) |

Bash tool subprocesses get `HARNESS=1` so scripts can detect they're running under the agent.
