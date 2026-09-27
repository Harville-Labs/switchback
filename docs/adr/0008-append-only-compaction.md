# 0008: Append-only context compaction

**Status:** Accepted · 2026-09-27

## Context

Long sessions outgrow the local model's context window. Past that point every call escalates (`context-overflow`), so a long task quietly becomes a remote task, and eventually outgrows the remote window too. [ADR 0003](0003-neutral-append-only-transcript.md) requires that history is never edited, so compaction can't rewrite earlier messages.

## Decision

Compaction appends a **marker**, and the engine builds each request's context from the latest marker. Nothing earlier is changed or removed.

- The marker is a user message whose only part is `{ type: "compaction", summary, keepFrom }`. `summary` covers everything before `keepFrom`, including any earlier summary. `keepFrom` is the index of the first message kept verbatim.
- The context sent to a model is: the summary as a user message, then the messages from `keepFrom` onward, with marker messages left out. Adapters never see markers.
- `keepFrom` always points at an assistant message, so no tool call is separated from its result and the kept slice follows the summary with valid role alternation on every provider.
- The recent part of the conversation (`compaction.keepRecent` of the window) is kept verbatim so the model keeps exact tool results and code it's working on.
- Summaries are written locally when possible. The engine uses the first reachable local model and summarizes in chunks that fit its window, folding each chunk into a running summary. Only when no local model is reachable, routing isn't `local-only`, and the budget allows, does a remote model write it. That call is shown as `route.decided` with `rule: compaction` and billed under that rule. Local never silently costs money (invariant 10).
- The engine compacts automatically when the prompt passes `compaction.threshold` of the largest local window (or of the first remote window when there's no local model), before routing decides anything. `session.compact` compacts on request.
- The full transcript stays on disk. Clients show the marker as a note, and resuming a session rebuilds the same context from the same marker.

## Consequences

- A long session can stay on the local tier indefinitely instead of drifting remote.
- The request prefix changes once per compaction, so the next remote call re-writes the provider's cache. Compaction is rare (it fires at a threshold, then leaves plenty of room), so this is a small, visible cost.
- Summaries lose detail. Keeping recent messages verbatim limits the damage to older context, and the original transcript is still there for the user.
- Reasoning before `keepFrom` is no longer replayed. Providers accept that; it's the same as a model switch.
