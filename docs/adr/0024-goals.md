# 0024: Goals keep a session working across turns

**Status:** Accepted · 2026-10-21

## Context

Some tasks take more than one turn: "make the test suite pass", "migrate every caller off the old API". Today the model ends its turn, and the user has to type "keep going" until the work is done. Other agents offer this as a loop:

- **Codex `/goal`** stores the goal, puts a continuation prompt in at each turn boundary, and gives the model tools to read the goal and mark it complete. A token budget makes it stop softly.
- **Claude Code `/goal`** has a small evaluator model check the goal after every turn.
- **OpenCode plugins** look for a completion phrase in the reply, cap the number of iterations, and guard against turns that make no progress.

Each approach has a cost. An evaluator model doubles the calls and sends the transcript to a second model, which may be remote. A completion phrase can be matched by accident or missed. A loop that ignores budgets or permission prompts would break invariant 10 (local never silently costs money) and the permission gate.

## Decision

`/goal <objective>` sets a goal on a top-level session and starts a turn with the objective as its prompt. When a turn ends with the goal still active, the engine starts another turn.

- **The goal is session state in the engine's memory**, not part of the transcript. The model is told about it with the first prompt, and each continuation turn starts with a reminder part appended to the transcript (invariant 4). A continuation names the objective in at most 200 characters, because the full text is already in the first prompt and repeating it every turn would only fill the context window. The system prompt never changes (invariant 7).
- **The model ends the goal with the `goal` tool**, with status `done` or `blocked` and a summary the user sees. Using a tool instead of a phrase means the end is explicit and costs no extra model call. The tool is offered to every top-level session, goal or not, so the tool list and cache prefix stay the same. It is appended to `ALL_TOOLS`.
- **Limits stop it:** `goal.maxTurns` (default 25) and `goal.maxMinutes` (default 120), checked when each turn ends, and three failed turns in a row (errors or refusals).
- **The user stops it:** Esc cancels the running turn and stops the goal. `/goal stop` lets the running turn finish and starts no more. A prompt that interrupts a turn changes its direction without ending the goal.
- **Nothing is approved for it.** Continuation turns route like any other turn, so budgets, `remote` blocks, and escalation prompts apply (invariant 10). Permission prompts pause the turn until the user answers, and headless mode still denies them.
- **The goal isn't saved with the session.** Resuming a session after the engine restarts doesn't pick the goal up again, so a session never starts spending on its own.

The protocol gets one method, `session.setGoal` (an objective, or `null` to stop), and one event, `goal.updated`. Both clients show the active goal and its turn count above the prompt from the shared view model, and note when a goal starts and ends.

## Consequences

- Every top-level request carries one more tool definition, about 115 tokens.
- How well a goal ends depends on the model calling `goal`. A model that never calls it runs until a limit, and the turn cap bounds that.
- Goals don't survive an engine restart. If people want that later, a header field and an explicit resume step would add it without changing the protocol.
- Subagents can't have goals. A parent that wants one can give a subagent a task and check the result itself.
