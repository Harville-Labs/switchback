# Choose your models

Switchback starts each turn on the model you pick and escalates to a stronger one only when the turn needs it. Any mix works:

- **Local first**: a model on your machine or your network (Ollama, LM Studio, llama.cpp, vLLM, …) starts every turn, and a hosted model takes the hard ones.
- **All local**: nothing leaves your machine.
- **All hosted**: OpenAI, Anthropic, Gemini, DeepSeek, Bedrock, Vertex, Azure, OpenRouter, or any OpenAI-compatible API, with a cheaper model starting and a stronger one escalating.

**Set Up Models** asks a few questions right here: your local model endpoints and which of their models to use, any remote providers, and which model does what. It finds servers running on this machine, reads keys from your environment, and writes `~/.switchback/config.json`, the same file `switchback init` writes. No terminal or CLI needed. Run it again any time to change your mind.
