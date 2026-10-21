# 0023: Web search runs without asking by default

**Status:** Accepted · 2026-10-21

## Context

`websearch` and `webfetch` shared the `web` permission level, which asks by default. Searching is how a model checks a library's current API or an error message it hasn't seen, so the prompt came up often, and people answered it with "always" almost every time. The two tools don't carry the same risk. A search sends a query to one service the user configured (Exa unless they chose another). A fetch can go to any URL, and a URL can carry anything, so a prompt-injected page could use it to send workspace content anywhere.

## Decision

- A new level, `permissions.websearch`, rules on `websearch` (and Claude Code's `WebSearch`) and defaults to `allow`. `permissions.web` still rules on `webfetch` and defaults to `ask`.
- `web: deny` turns search off too, and rules (`deny: ["websearch"]`, `ask: ["websearch"]`) still beat the level.
- An organization can enforce `websearch` like the other levels.
- Sessions holding private content still get no web tools at all.
- Starting from OpenCode maps its `websearch` permission to this level instead of tightening `web`.

## Consequences

- Queries reach the search backend without a prompt. The model writes them, so a query can contain words from the workspace. People who don't want that set `permissions.websearch` to `ask` or `deny`, or point `web.search` at a self-hosted SearXNG.
- Fetching a page still asks, so search results can be read only after the user approves each host, or allows `webfetch` themselves.
