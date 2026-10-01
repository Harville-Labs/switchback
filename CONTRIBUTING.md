# Contributing

Switchback is developed by Harville Labs. This guide covers the workflow for anyone working on the codebase, including AI agents. Read [AGENTS.md](AGENTS.md) first; it has the architecture rules.

## Licensing of contributions

Switchback is licensed under Apache-2.0, and contributions are accepted under the same license (section 5 of the [LICENSE](LICENSE)); there's no separate agreement to sign. `apps/site` is proprietary and developed by Harville Labs only, so pull requests that change it can't be accepted from outside contributors.

## Setup

```sh
bun install          # Bun 1.4+
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

## Live tests

Unit tests never touch real models. `bun run test:live` runs scenarios against a real local model (detected, or `SWITCHBACK_LIVE_LOCAL_URL` + `SWITCHBACK_LIVE_LOCAL_MODEL`) and against every hosted provider whose API key is set (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`), each on its cheapest model; the run prints what it spent. The **Live models** workflow runs nightly with an Ollama container and can be triggered manually with a different model. Run it before changing an adapter.

## Labels

| Label | Meaning |
|---|---|
| `area:engine`, `area:router`, `area:providers`, `area:protocol`, `area:subagents`, `area:tui`, `area:vscode`, `area:docs`, `area:infra` | Where the work lives |
| `P0` / `P1` / `P2` | Blocks release / important / nice to have |
| `type:feature`, `type:bug`, `type:chore` | Kind of work |
| `good first issue` | Small and well-scoped |

## Releases

Versions follow SemVer. Until 1.0, minor versions may break config or protocol, and such changes are called out in the changelog. The CLI, engine, and VS Code extension always share one version (a test enforces it).

To cut a release:

```sh
bun scripts/release.ts prepare 0.2.0   # bumps every version, moves Unreleased notes under [0.2.0]
# review CHANGELOG.md, commit "chore(release): v0.2.0", push
git tag v0.2.0 && git push origin v0.2.0
```

The tag runs `.github/workflows/release.yml`:

1. `bun run check`, then `release.ts verify` (all versions and the changelog entry match the tag).
2. Binaries for linux-x64, darwin-arm64, and windows-x64 are built and smoke-tested on native runners. linux-arm64 and darwin-x64 are cross-compiled and format-checked.
3. The `.vsix` is built.
4. A GitHub Release is created with the binaries, the `.vsix`, `SHA256SUMS`, and the changelog section as notes. 0.x and `-pre` versions are marked prerelease.

Code signing, notarization, and Marketplace publishing are tracked in #33 and #30.
