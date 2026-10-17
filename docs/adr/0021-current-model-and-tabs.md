# 0021: The current model, and tabs in the clients

**Status:** Accepted · 2026-10-17 · amends [0015](0015-role-based-routing.md)

## Context

ADR 0015 named the role where turns begin `start`. People think of it as the model they're using, and they want to change it the way chat apps let them: a dropdown in VS Code, one command in the terminal. "Start" read as a one-time choice, and changing it meant opening a role picker or typing `/start <alias>` from memory.

People also run several sessions at once (a long refactor in one, a quick question in another) and use the terminal and VS Code side by side on the shared engine. Each client showed one session, so the others were invisible until you resumed them, and a permission prompt in a session you weren't looking at waited unseen.

## Decision

**The role is `current`.** `routing.current`, `SessionRoles.current`, `/current`, and `--current` replace `start`, `/start`, and `--start`. It's the same chain with the same semantics: the first model that's up and fits, then backups.

- Unlike the 0015 renames, this one keeps working. `routing.start` is read as `routing.current` (the new name wins when a file sets both), in every layer including organization policy, and writing a config layer moves it. `--start` and `/start` stay as aliases. Nobody's routing changes on upgrade.
- The protocol rename bumps `PROTOCOL_VERSION` to 2. The shared daemon already handles a version change: the newer client asks an idle older daemon to retire, or runs its own engine and says why.
- **Picking a model keeps the old ones as backups.** Choosing a model from the dropdown or the `/current` picker puts it first and keeps the previous chain behind it (`currentChange` in `@switchback/client/models`), so a quick switch never removes the fallback for an outage or an oversized prompt. Escalation still climbs from it.

**Tabs and the dashboard live in the clients.** The engine already sends every client every session's events. `@switchback/client/tabs` folds them into one view per open tab (`reduceTabs`) and a summary per top-level session (running, waiting for the user, model, what it's doing, cost), and `dashboardRows` lists open tabs, then sessions working or waiting in other windows. Both clients render from it (invariant 2), so they show the same states with the same words.

- No protocol method or event was added; tabs are a view of sessions, not engine state. `session.list` seeds and refreshes titles and running flags.
- Closing a tab doesn't stop its session. A running turn finishes in the background and stays on the dashboard.
- An event goes to the tab whose session tree owns it, including a subagent's prompt that arrives before its parent's view knows the subagent, so a prompt never shows in the wrong tab.
- Rejected: one engine connection per tab. Every connection already sees every session, so it would add processes and no information.
- Rejected: a separate dashboard surface in VS Code (a tree view). It would need its own rendering of the same rows; the dashboard is a view inside the chat, next to the tabs it switches.

## Consequences

- Third-party clients on protocol 1 need to rename `start` to `current` and bump their version.
- A session started in another window before this client attached shows as working (from `session.list`), but a prompt it was already waiting on shows only once its tab is open here, since the engine doesn't replay `permission.requested`.
- A client keeps a view for each open tab, so memory grows with open tabs, not with saved sessions.
