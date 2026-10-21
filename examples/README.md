# Examples

`switchback init` writes an equivalent config for you. Copy any of these to `.switchback/config.json` (project) or `~/.switchback/config.json` (user) and adjust.

| File | Setup |
|---|---|
| [ollama-openai.jsonc](ollama-openai.jsonc) | Ollama locally, OpenAI remotely |
| [lmstudio-deepseek.jsonc](lmstudio-deepseek.jsonc) | LM Studio locally, DeepSeek remotely (thinking mode on) |
| [ollama-anthropic.jsonc](ollama-anthropic.jsonc) | Ollama locally, Anthropic remotely, with an approval prompt and daily budget |
| [llamacpp-bedrock.jsonc](llamacpp-bedrock.jsonc) | llama.cpp locally, Claude on Amazon Bedrock |
| [lmstudio-vertex.jsonc](lmstudio-vertex.jsonc) | LM Studio locally, Claude on Vertex AI |
| [vllm-openrouter.jsonc](vllm-openrouter.jsonc) | A vLLM box locally, any OpenRouter model remotely |
| [multi-provider.jsonc](multi-provider.jsonc) | Two local servers (laptop and GPU box) and three hosted providers as ordered fallbacks |
| [mcp.jsonc](mcp.jsonc) | MCP servers (stdio and HTTP) alongside your models |
| [agents/](agents/) | Agent definitions (Claude Code compatible) |

## Terminals

Most terminals use Ctrl+Tab and Ctrl+Shift+Tab to switch their own tabs, so the terminal UI never sees them. These unbind them so they switch Switchback's tabs instead ([Tabs](../docs/clients/tui.md#tabs)).

| File | Terminal |
|---|---|
| [terminals/kitty.conf](terminals/kitty.conf) | kitty: add to `~/.config/kitty/kitty.conf` |
| [terminals/ghostty.conf](terminals/ghostty.conf) | Ghostty: add to `~/.config/ghostty/config` |
| [terminals/wezterm.lua](terminals/wezterm.lua) | WezTerm: merge into `~/.wezterm.lua` (also turns on kitty's keyboard protocol) |
| [terminals/iterm2.md](terminals/iterm2.md) | iTerm2: steps in its settings, which aren't a text file |
