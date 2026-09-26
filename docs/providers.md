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
- Set `contextWindow` to what the server actually loads, not the model's theoretical maximum. Ollama loads models with a 4096-token context unless you raise it with `OLLAMA_CONTEXT_LENGTH` or `num_ctx` in a Modelfile. That's too small for agent work; use 32768 or more. `harness init` reads the effective value from each server.
- Reasoning output (`reasoning_content` / `reasoning`) is shown in the UI but never sent back to the server.

Health is checked with `GET {baseUrl}/models` (2-second timeout, cached for 30 seconds). If it fails, routing falls back to remote.

## Remote: Claude

All three platforms use the same adapter (the Anthropic Messages API through the official SDKs) with different client construction.

### Anthropic API

```jsonc
"providers": { "anthropic": { "type": "anthropic" } }
```

Credentials resolve through the SDK chain: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, an `ant auth login` profile, or workload identity federation. You can also set `"apiKey": "{env:MY_VAR}"`.

### Amazon Bedrock

```jsonc
"providers": { "bedrock": { "type": "bedrock", "region": "us-east-1", "profile": "work" } },
"models": {
  "remote": { "provider": "bedrock", "model": "anthropic.claude-opus-5", "contextWindow": 1000000,
              "price": { "input": 5, "output": 25 } }
}
```

Uses the Mantle client from `@anthropic-ai/bedrock-sdk` and standard AWS credentials (environment, profile, SSO, instance role). Model IDs take the `anthropic.` prefix. `eagerToolInputStreaming` is off by default because older Bedrock deployments reject it; turn it on for current models.

### Google Vertex AI

```jsonc
"providers": { "vertex": { "type": "vertex", "projectId": "my-project", "region": "global" } },
"models": { "remote": { "provider": "vertex", "model": "claude-opus-5", "contextWindow": 1000000 } }
```

Uses Application Default Credentials (`gcloud auth application-default login`).

### What the adapter does

- Streams with adaptive thinking (summarized display) on models that support it. Haiku 4.5 runs without thinking.
- Sets `cache_control` at the top level so the stable prefix (system prompt, tools, earlier turns) is cached automatically.
- Streams tool inputs eagerly where supported. The engine validates every tool input against its schema before running it, and never runs tools from a response cut off by `max_tokens` or `refusal`.
- Sets `output_config.effort` when the model config has `effort`.
- Maps rate limits, 5xx errors, and connection failures to retryable errors so the router can fall back.

## Mock

`{ "type": "mock", "tier": "local" }` echoes the prompt. `--mock` on any CLI command swaps every provider for a mock. Use it for UI work, demos, and CI.

## Adding a provider

See "Add a provider" in [AGENTS.md](../AGENTS.md). Candidates on the roadmap: OpenAI, Gemini, Claude Platform on AWS (`@anthropic-ai/aws-sdk`), Microsoft Foundry, and MLX.
