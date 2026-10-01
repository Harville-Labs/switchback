# 0003: Provider-neutral, append-only transcript

**Status:** Accepted · 2026-09-26

## Context

One session may use several models: a local model and a hosted one (OpenAI, Anthropic, DeepSeek, ...), sometimes within a single user turn. Provider prompt caches are prefix-matched. Claude validates that replayed thinking blocks belong to an unmodified conversation from the same model, and DeepSeek requires its own earlier reasoning to be sent back in tool-call conversations.

## Decision

- The engine stores sessions in its own neutral format (`Message` / `Part` in `@switchback/protocol`). Adapters translate at the edge.
- History is append-only, in memory and on disk (JSONL). Nothing edits or deletes earlier messages.
- `ReasoningPart` records its `origin` model and an opaque provider payload (e.g. a Claude thinking signature). Adapters replay reasoning only to that exact model, and only where the provider wants it back (Claude, DeepSeek); others never see it.
- The system prompt is frozen at session creation. The tool list has a fixed order.

## Consequences

- Cache hit rates stay high within a model, and switching models never corrupts history for the next call.
- Context compaction, when we build it, must be an explicit, append-only operation (a summary message plus a marker), not an in-place rewrite. It needs its own ADR.
