# 0003: Provider-neutral, append-only transcript

**Status:** Accepted · 2026-09-26

## Context

One session may use several models: a local model through an OpenAI-compatible API and Claude through the Messages API, sometimes within a single user turn. Provider prompt caches are prefix-matched, and Claude validates that replayed thinking blocks belong to an unmodified conversation from the same model.

## Decision

- The engine stores sessions in its own neutral format (`Message` / `Part` in `@harness/protocol`). Adapters translate at the edge.
- History is append-only, in memory and on disk (JSONL). Nothing edits or deletes earlier messages.
- `ReasoningPart` records its `origin` model and an opaque provider payload (e.g. the thinking signature). Adapters replay reasoning only to that exact model.
- The system prompt is frozen at session creation. The tool list has a fixed order.

## Consequences

- Cache hit rates stay high within a model, and switching models never corrupts history for the next call.
- Context compaction, when we build it, must be an explicit, append-only operation (a summary message plus a marker), not an in-place rewrite. It needs its own ADR.
