# 0017: AGENTS.md changes reach running sessions

**Status:** Accepted · 2026-10-09

## Context

Switchback read `AGENTS.md` once, when the engine started, and put it in each session's system prompt. Invariant 7 freezes that prompt for the session's life, because provider prompt caches and reasoning replay depend on a stable prefix ([ADR 0003](0003-neutral-append-only-transcript.md), [ADR 0008](0008-append-only-compaction.md)).

So an edit to `AGENTS.md` did nothing until the engine restarted, and the shared daemon outlives any one client. With two sessions side by side, one session (or the user) adds a rule and the other keeps working without it. The same holds for `~/.switchback/AGENTS.md`.

There's more than one engine to reach: sessions on the shared daemon share one, but a `--no-daemon` TUI, a VS Code private engine, `switchback run`, and `switchback acp` with a private engine each run their own.

## Decision

A session's system prompt is never rewritten. A change is **appended** to each running session as a note to the model, the way plan mode already tells the model it's on.

1. **The files are the source of truth, and every engine watches them** (`WatchedInstructions` in `instructions-live.ts`). It watches their folders with `fs.watch` (editors often save by replacing the file), debounced, and also re-checks them (a `stat`, then a read only if it changed) before each prompt and each new session, because `fs.watch` misses changes on network file systems and in some containers. Separate engines need no messages between them; each sees the same files.
2. **New sessions use the current text.**
3. **Running sessions get a note with their next prompt.** A session's header records the hashes of the files its system prompt was built with. When the user's next prompt is appended and a file has changed since what the model was told, the same user message gets a `reminder` text part with the whole new text ("These instructions replace the "Project instructions" section of your system prompt: …") or, for a deleted file, an instruction to disregard that section. The part carries `instructions: { scope, hash }`, so what a session was told can be worked out from its transcript after a restart. The note is in the same message as the prompt, so role alternation is untouched and the cached prefix stays valid up to the new message.
4. **Subagents** created after a change get the new text in their system prompt. Running ones get the note with their next prompt from the parent.
5. **Compaction keeps it.** When `contextOf()` builds a request from a compaction marker, the summary message carries the latest instruction note of each file from the compacted part. History before a marker never changes, so this is the same for every request and doesn't disturb the cache.
6. **Clients hear about it** through `config.updated`, whose `notes` every client already shows ("The project's AGENTS.md changed; sessions get it with their next message"). No new event or protocol version.
7. Sessions created before this change have no recorded hashes and are taken to be up to date.

Invariant 7 now reads: the system prompt is frozen when a session is created; later changes to instructions are appended as reminders, never written into it.

### Rejected

- **Rewriting the system prompt.** Breaks caches and reasoning replay, and makes the transcript disagree with what was sent.
- **Restarting or forking sessions.** Loses context the user didn't ask to lose.
- **Notifying other engines over IPC.** The file system already reaches every engine on the machine, including ones that start later.
- **Delivering mid-turn, between model calls.** The note would need a user message between a tool result and the next call, which some providers reject. A long turn finishes under the instructions it started with.
- **Sending a diff.** Smaller, but easier for a model to misapply, and the saving is small for a file that changes rarely.
- **Marking the note private.** The same text goes to every model in the system prompt already; treating the note differently would pin sessions local for no reason.

## Consequences

- An `AGENTS.md` edit, by you or by a session's own `edit` call, reaches every session on the machine at its next message, with no restart.
- Each change costs one copy of the file per running session, once.
- A turn already running doesn't see the change until it ends.
- The same watcher could later reload config files (`engine.applyConfig` already applies a new config live).
