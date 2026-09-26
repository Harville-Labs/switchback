# 0001: One engine, thin clients

**Status:** Accepted · 2026-09-26

## Context

We need a first-class terminal experience and a first-class VS Code extension, and they must not contradict each other. If each client implemented agent behavior (routing, tools, permissions, prompts), they would drift. Every fix would have to land twice, and customers would see different results in each.

## Decision

All behavior lives in a headless engine (`@harness/engine`). Clients connect over a versioned JSON-RPC protocol (`@harness/protocol`) and render from a shared reducer (`@harness/client/view`).

- The VS Code extension spawns `harness serve --stdio`.
- The TUI runs the engine in-process but still connects through an in-memory transport pair that JSON round-trips every message. There is no private API.
- Configuration that affects behavior lives only in harness config files, never in client settings.

## Consequences

- Any capability a client needs becomes a protocol method or event first, so third-party clients get it too.
- Slight overhead for the TUI (serialization), which is negligible next to model latency.
- A future shared daemon (TUI and VS Code attached to the same live session) needs only a socket transport, not a redesign.
