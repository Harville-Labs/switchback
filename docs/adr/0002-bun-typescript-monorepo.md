# 0002: Bun + TypeScript monorepo

**Status:** Accepted · 2026-09-26

## Context

The VS Code extension must be TypeScript. The CLI needs fast startup, good TUI libraries, and a way to ship a single binary to customers. Sharing the protocol and view model across both is essential (ADR 0001).

## Decision

- One Bun workspace with packages under `packages/` and apps under `apps/`.
- Bun runs TypeScript directly in development and tests (`bun test`). No build step for packages.
- The CLI ships as a single executable (`bun build --compile`) per platform.
- The VS Code extension is bundled for Node (`--target=node --format=cjs`) and for the browser (the webview). Code shared with it must not use Bun-only APIs; `@harness/client` uses `node:child_process`.
- One root `tsconfig.json` typechecks everything (`tsc --noEmit`). Biome handles lint and format, matching other Harville Labs repos.

## Consequences

- Engine code may use Bun APIs (`Bun.spawn`, `Bun.Glob`) because it only runs inside the harness binary.
- Contributors need Bun 1.3+.
