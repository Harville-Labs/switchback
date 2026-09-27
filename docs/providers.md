# Providers

A **provider** is a connection to a model server. A **model** (under `models` in config) is a named alias that points at one model on one provider. Routing works on aliases, so you can swap what `local` or `remote` means without touching agents.

## Local: OpenAI-compatible servers

Any server exposing `/v1/chat/completions` with SSE streaming and function calling works. Tier defaults to `local`.

```jsonc
"providers": {
  "ollama":   { "type": "openai-compatible", "baseUrl": "http://localhost:11434/v1" },
  "llamacpp": { "type": "openai-compatible", "baseUrl": "http://localhost:8080/v1" },
  "lmstudio": { "type": "openai-compatible", "baseUrl": "http://localhost:1234/v1" },
  "vllm":     { "type": "openai-compatible", "baseUrl": "http://gpu-box:8000/v1", "apiKey": "{env:VLLM_KEY}" }
},
"models": {
  "local": { "provider": "ollama", "model": "<model name>", "contextWindow": 32768 }
}
```

`harness init` detects these servers and fills this in for you. There is no default local model.

Choosing a local model:

- It must support **tool calling** through the chat completions API. Models without it will trip the malformed-tool-call signal and escalate constantly.
- Set `contextWindow` to what the server actually loads, not the model's theoretical maximum. Ollama loads models with a 4096-token context unless you raise it with `OLLAMA_CONTEXT_LENGTH` or `num_ctx` in a Modelfile. That's too small for agent work; use 32768 or more. `harness init` reads the effective value from each server, and if you leave `contextWindow` out the engine asks the server at runtime (`doctor` shows the value and where it came from).
- Reasoning output (`reasoning_content` / `reasoning`) is shown in the UI but never sent back to the server.

Health is checked with `GET {baseUrl}/models` (2-second timeout, cached for 30 seconds). If it fails, routing falls back to remote.

## Remote providers

Harness treats hosted providers equally. None is a default: `harness init` asks which one to use, and you can configure several (for example OpenAI as `remote` and DeepSeek for a cheap subagent alias). Known models and list prices live in `packages/providers/src/catalog.ts`. Anything else works when configured by hand.

| Type | Models offered by `harness init` | Credentials |
|---|---|---|
| `anthropic` | Claude Opus 5, Sonnet 5, Haiku 4.5 | `ANTHROPIC_API_KEY`, `ant auth login`, or `apiKey` |
| `openai` | GPT-6 Astra, Sol, Luna | `OPENAI_API_KEY` or `apiKey` |
| `deepseek` | DeepSeek V4 Pro, V4.1 Flash | `DEEPSEEK_API_KEY` or `apiKey` |
| `bedrock` | Claude models on AWS | AWS credential chain |
| `vertex` | Claude models on Google Cloud | Application Default Credentials |
| `openai-compatible` with `tier: remote` | Any model: OpenRouter, Together, Groq, Fireworks, a vLLM cluster | `apiKey` (use `{env:NAME}`) |

### Model aliases are tiers

Agent definitions can say `model: opus`, `model: sonnet`, or `model: haiku`. The names come from Claude Code agent files, but in Harness they mean the **large, medium, and small** model of whichever remote provider you chose. Setup maps them from the catalog:

| Alias | Anthropic | OpenAI | DeepSeek |
|---|---|---|---|
| `opus` (large) | claude-opus-5 | gpt-6-astra | deepseek-v4-pro |
| `sonnet` (medium) | claude-sonnet-5 | gpt-6-sol | deepseek-v4-pro (no medium; next larger) |
| `haiku` (small) | claude-haiku-4-5 | gpt-6-luna | deepseek-flash |

Point any alias at any provider in config. If an agent names an alias that isn't configured, the pin is ignored and normal routing applies.

### OpenAI

```jsonc
"providers": { "openai": { "type": "openai" } },
"models": { "remote": { "provider": "openai", "model": "gpt-6-sol", "contextWindow": 1050000, "effort": "medium" } }
```

Uses Chat Completions with streaming and function calling. Sends `max_completion_tokens` (OpenAI's reasoning models reject `max_tokens`) and passes `effort` through as `reasoning_effort`. Cached prompt tokens (`prompt_tokens_details.cached_tokens`) are priced at the cached rate. Optional: `baseUrl` (Azure OpenAI or a proxy) and `organization`.

### DeepSeek

```jsonc
"providers": { "deepseek": { "type": "deepseek" } },
"models": { "remote": { "provider": "deepseek", "model": "deepseek-v4-pro", "contextWindow": 1000000, "effort": "high" } }
```

Setting `effort` turns on DeepSeek's thinking mode (`thinking: {type: enabled}` plus `reasoning_effort`, where `medium` maps to `high` and `xhigh` to `max`). In thinking mode with tools, DeepSeek requires earlier reasoning to be sent back, so the adapter replays `reasoning_content`, but only reasoning that the same DeepSeek model produced. Cache hits (`prompt_cache_hit_tokens`) are priced at the cache rate. Catalog prices are DeepSeek's peak-hour rates, so reported costs are upper bounds (off-peak is half).

### Anthropic API

```jsonc
"providers": { "anthropic": { "type": "anthropic" } },
"models": { "remote": { "provider": "anthropic", "model": "claude-opus-5", "contextWindow": 1000000 } }
```

Uses the official Anthropic SDK. Credentials resolve through its chain: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, an `ant auth login` profile, or workload identity federation.

### Amazon Bedrock and Google Vertex AI

```jsonc
"providers": {
  "bedrock": { "type": "bedrock", "region": "us-east-1", "profile": "work" },
  "vertex": { "type": "vertex", "projectId": "my-project", "region": "global" }
},
"models": {
  "remote": { "provider": "bedrock", "model": "anthropic.claude-opus-5", "contextWindow": 1000000,
              "price": { "input": 5, "output": 25 } }
}
```

Bedrock uses the Mantle client from `@anthropic-ai/bedrock-sdk` with standard AWS credentials; model IDs take the `anthropic.` prefix, and `eagerToolInputStreaming` is off by default because older deployments reject it. Vertex uses Application Default Credentials. Both bill differently from the first-party API, so set `price` for accurate savings.

### Any other OpenAI-compatible API

```jsonc
"providers": {
  "openrouter": { "type": "openai-compatible", "tier": "remote",
                  "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "{env:OPENROUTER_API_KEY}" }
},
"models": {
  "remote": { "provider": "openrouter", "model": "qwen/qwen3-coder", "contextWindow": 262144,
              "price": { "input": 0.4, "output": 1.6 } }
}
```

### Behavior common to every remote

- Streaming output and tool calls, normalized into one transcript format, so a session can move between providers mid-turn.
- Reasoning is kept in the transcript with the model that produced it and is only ever sent back to that model (Claude thinking signatures, DeepSeek `reasoning_content`).
- Prompt caching: Claude gets a top-level `cache_control` breakpoint; OpenAI and DeepSeek cache automatically. The engine keeps the system prompt and tool list byte-stable to make all three effective.
- `effort` maps to each provider's control: `output_config.effort` (Claude), `reasoning_effort` (OpenAI), thinking plus `reasoning_effort` (DeepSeek).
- Rate limits, 5xx errors, and connection failures are retryable, so the router can fall back.
- The engine validates every tool input against its schema and never runs tools from a response cut off by `max_tokens` or a refusal.

## Mock

`{ "type": "mock", "tier": "local" }` echoes the prompt. `--mock` on any CLI command swaps every provider for a mock. Use it for UI work, demos, and CI.

## Adding a provider

See "Add a provider" in [AGENTS.md](../AGENTS.md). Candidates on the roadmap: Gemini, the OpenAI Responses API, Claude Platform on AWS, Microsoft Foundry, and MLX. A new provider must get the same treatment as the existing ones: a catalog entry, setup support, pricing, and tests ([ADR 0006](adr/0006-provider-neutrality.md)).
