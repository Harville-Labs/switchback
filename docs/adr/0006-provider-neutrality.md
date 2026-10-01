# 0006: Provider neutrality

**Status:** Accepted · 2026-09-26

## Context

Switchback started with Claude as the built-in remote model and Claude-specific defaults (model aliases, pricing, setup options). Customers run on whatever their company has approved: OpenAI, Anthropic, DeepSeek, a cloud marketplace, or an internal OpenAI-compatible gateway. A tool that quietly prefers one vendor is harder to sell and harder to trust.

## Decision

- **No default vendor.** Built-in config has no providers or models. `switchback init` asks, and lists hosted providers side by side with the same prompts.
- **One catalog.** Every known hosted model (ID, size tier, context window, list price) lives in `packages/providers/src/catalog.ts`. Setup and pricing both read from it. Adding a model means adding it there.
- **Aliases are tiers.** `opus`, `sonnet`, and `haiku` (kept for Claude Code agent-file compatibility) mean large, medium, and small on the chosen provider.
- **Equal features.** Streaming, tool calls, reasoning capture and replay, caching-aware pricing, effort control, health checks, and setup are implemented for each first-class provider (Anthropic, OpenAI, DeepSeek) and for generic OpenAI-compatible APIs. Where a provider lacks something, the docs say so.
- **Provider code stays in `packages/providers`.** Nothing else branches on vendor.

## Consequences

- New providers must be added fully (catalog, setup, pricing, docs, tests), not just an adapter.
- Catalog prices go stale; each entry carries the date it was checked, and users can override prices in config.
- Agent files written for Claude Code keep working on any provider.
