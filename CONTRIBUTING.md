# Contributing

Harness is developed by Harville Labs. This guide covers the workflow for employees, contractors, and AI agents working on the codebase. Read [AGENTS.md](AGENTS.md) first; it has the architecture rules.

## Setup

```sh
bun install          # Bun 1.3+
bun run check        # must pass before you start and before you push
```

## Workflow

1. **Start from an issue.** If none exists, open one using a template. Issues carry an `area:` label, a priority (`P0` to `P2`), and a milestone.
2. **Branch** from `main` as `<type>/<issue>-<slug>`, for example `fix/31-ollama-timeout`.
3. **Commit** using [Conventional Commits](https://www.conventionalcommits.org): `feat(router): ...`, `fix(tui): ...`, `docs: ...`, `chore(ci): ...`. The scope is the package or app name.
4. **Open a PR** using the template, link the issue (`Closes #31`), and fill in the testing section with what you actually ran.
5. **CI must be green**: Biome, TypeScript, tests, and both app builds.
6. **Squash-merge** after review. The squash title becomes the changelog entry.

## What a complete change includes

- Tests. Router rules get unit tests; engine behavior gets a `ScriptedProvider` test; protocol changes get a round-trip test.
- Docs updated in the same PR: config keys in `docs/configuration.md`, routing rules in `docs/routing.md`, protocol changes in `docs/protocol.md`.
- An ADR in `docs/adr/` if you change an invariant from AGENTS.md.
- A `CHANGELOG.md` entry under *Unreleased* for anything user-visible.

## Labels

| Label | Meaning |
|---|---|
| `area:engine`, `area:router`, `area:providers`, `area:protocol`, `area:subagents`, `area:tui`, `area:vscode`, `area:docs`, `area:infra` | Where the work lives |
| `P0` / `P1` / `P2` | Blocks release / important / nice to have |
| `type:feature`, `type:bug`, `type:chore` | Kind of work |
| `good first issue` | Small and well-scoped |

## Releases

Versions follow SemVer. Until 1.0, minor versions may break config or protocol, and such changes are called out in the changelog. The CLI and VS Code extension are released together with matching versions.
