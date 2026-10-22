# 0027: Map-reduce compaction with a kept record

**Status:** Accepted · 2026-10-22

Supersedes the part of [ADR 0008](0008-append-only-compaction.md) that says how a summary is written. The append-only marker, `keepFrom`, and when compaction fires are unchanged.

## Context

ADR 0008 summarized a long history by folding chunks into a running summary, one after another. Each fold rewrote the whole summary, so details from early chunks wore away a little more with every later one. The summarizer is usually a small local model, which makes that loss worse. It also read tool output that a later call had already replaced (a file read before it was edited), spending its window on stale text. And a compaction of a long history ran for a while with nothing on screen.

## Decision

- **Prune first.** Output of a tool call that a later call superseded (the same call made again, or a read of a file that was read, written, or edited afterwards) is replaced by a one-line note in what the summarizer reads. The transcript itself is untouched.
- **Map, then reduce.** The history is cut into parts of at most half the summarizer's window. Each part is summarized on its own, two at a time. The summaries are then merged in groups sized to fit the window, oldest first, until one is left. The previous compaction's summary is the first item of the merge. A history that fits in one part takes one call, as before.
- **A record kept word for word.** Every summary ends with a `## Record` section built from the transcript without a model: the last 12 user requests, the files changed, the files read, and the commands that failed. It's rebuilt from the whole compacted history each time and stripped before the summary is merged again, so it never passes through a model.
- **Progress.** The engine emits `context.compacting` with the phase and how many calls are done out of the total, then `end`. Both clients show it as their working status.
- **A session switch.** `session.setAutoCompact` (`/autocompact`) turns automatic compaction on or off for one session, over `compaction.enabled`, and can save the choice to the user config.

Which model writes summaries, and the rule that local never silently costs money, are as in ADR 0008.

## Consequences

- No part of the history is summarized more than a fixed number of times (once, then about log n merges), instead of once per later chunk.
- What the user asked for and which files changed survive any number of compactions exactly.
- A long compaction makes more model calls than the fold did (one per part plus the merges). Running two at a time and showing progress keeps that tolerable on a local model.
- Each summary is a little longer because of the record, bounded by its caps.
