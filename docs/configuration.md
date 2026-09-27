# Configuration reference

## Files and precedence

Layers deep-merge in this order, with later layers winning:

1. Built-in defaults (below)
2. Organization policy `defaults`, when signed in ([organizations.md](organizations.md))
3. `~/.config/harness/config.json` (user; respects `XDG_CONFIG_HOME`)
4. `.harness/config.json` in the workspace (project)
5. Organization policy `enforced`, then its `restrictions`
6. `--mock` (any command) then swaps every provider for a scripted mock

Files are JSON with `//` and `/* */` comments allowed. Any string of the form `{env:NAME}` is replaced with that environment variable, so secrets stay out of files. `harness doctor` shows which files were loaded.

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

`harness init` probes Ollama (11434), LM Studio (1234), llama.cpp (8080), and vLLM (8000), lists their models with tool-calling support and the context size each server actually loads, and writes a config layer. It merges into an existing file, keeping unrelated keys, and saves the previous version as `config.json.bak` (comments are not preserved). Every prompt has a flag; see `harness --help`.

Machine-specific settings (which local server and model) belong in the user config. Team-shared settings (permissions, agents, budgets) belong in the project config.

The VS Code extension validates both files against the schema and offers autocomplete. Other editors can use the output of `harness config schema`.

## Built-in defaults

There are **no default providers or models**, local or remote. Harness doesn't choose a vendor for you; `harness init` writes the ones you pick. With nothing configured, `doctor` reports what's missing and `harness` offers setup.

If only one tier is configured:

- With no local model, `auto` routing sends turns remote and the route line says so. Agents pinned to `local` (such as `explore`) route normally instead of failing. `--route local`, `/local`, and `mode: local-only` are refused with a pointer to `harness init`.
- With no remote model, turns stay local and escalation is unavailable.

## Keys

### `providers.<id>`

| `type` | Fields |
|---|---|
| `openai-compatible` | `baseUrl` (required), `apiKey`, `tier` (`local`\|`remote`, default `local`), `headers` |
| `openai` | `apiKey` (default `$OPENAI_API_KEY`), `baseUrl` (default `https://api.openai.com/v1`), `organization` |
| `deepseek` | `apiKey` (default `$DEEPSEEK_API_KEY`), `baseUrl` (default `https://api.deepseek.com`) |
| `anthropic` | `apiKey`, `baseUrl` |
| `bedrock` | `region`, `profile`, `eagerToolInputStreaming` (default `false`) |
| `vertex` | `projectId` (required), `region` (default `global`) |
| `mock` | `tier` |

### `models.<alias>`

| Key | Default | |
|---|---|---|
| `provider` | required | A key of `providers` |
| `model` | required | The provider's model ID |
| `contextWindow` | detected / catalog | Tokens the model accepts; used by the context-overflow rule. Setup fills it from the catalog for hosted models. For local models it can be omitted, and the engine asks the server (Ollama, LM Studio, llama.cpp, vLLM). If the server can't say, it assumes 8,192 and `doctor` flags it. |
| `maxOutputTokens` | 16000 | `max_tokens` per call |
| `effort` | unset | `low`\|`medium`\|`high`\|`xhigh`\|`max`. Sent as `output_config.effort` (Anthropic), `reasoning_effort` (OpenAI), or thinking plus `reasoning_effort` (DeepSeek, where it turns thinking on). |
| `price` | built-in table | `{ input, output, cacheRead?, cacheWrite? }` in USD per million tokens |

### `routing`

See [routing.md](routing.md#configuration-reference).

### `permissions`

| Key | Default | Governs |
|---|---|---|
| `read` | `allow` | `read`, `glob`, `grep` |
| `edit` | `ask` | `write`, `edit` |
| `bash` | `ask` | `bash` |

Values are `allow`, `ask`, and `deny`. See [permissions.md](permissions.md).

### Other keys

| Key | Default | |
|---|---|---|
| `defaultAgent` | `build` | Agent for new sessions |
| `subagents.maxConcurrent` | 4 | Concurrent subagents per depth |
| `subagents.maxDepth` | 2 | Maximum nesting |
| `maxStepsPerTurn` | 50 | Model calls per user prompt before stopping |

## Environment variables

| Variable | Effect |
|---|---|
| `HARNESS_HOME` | Relocate all config and data |
| `HARNESS_ORG_SERVER`, `HARNESS_ORG_TOKEN` | Organization sign-in without `harness login` (CI, managed installs) |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Standard base directories |
| `OPENAI_API_KEY` | OpenAI credentials |
| `DEEPSEEK_API_KEY` | DeepSeek credentials |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE` | Anthropic credentials (SDK chain) |
| `AWS_REGION`, `AWS_PROFILE`, ... | Bedrock credentials (AWS chain) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vertex credentials (ADC) |

Bash tool subprocesses get `HARNESS=1` so scripts can detect they're running under the agent.
