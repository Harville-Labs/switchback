# 0004: Routing is a pure, explainable function

**Status:** Accepted · 2026-09-26

## Context

Routing is the core of the product's value, since it's where cost savings come from, and it's also where trust is won or lost. Users need to know why a call went remote. We need to test many edge cases (budget plus outage plus agent pin) without mocks.

## Decision

`Router.decide(input)` takes a snapshot (preference, agent pin, token estimate, quality signals, spend, and model availability through a lookup) and returns `route`, `ask`, or `block` with a `rule` name and a human-readable `reason`. It performs no I/O. The engine gathers inputs and acts on the result. Every decision is emitted as a `route.decided` event.

## Consequences

- Each rule is covered by table-style unit tests.
- New signals (latency, a difficulty classifier, learned escalation) plug in as snapshot fields plus rules, and the router stays pure.
