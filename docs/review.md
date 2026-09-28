# Draft locally, review remotely

An optional workflow: your local model writes the code, and a stronger remote model reviews what it changed. When the reviewer finds a real problem, the findings go back to the local model to fix, and the fix is reviewed again.

Writing code with a remote model is expensive because every step resends the growing conversation. Reviewing is cheap: the reviewer sees one diff and answers with a short verdict. You get most of the stronger model's judgment for a fraction of its cost.

```jsonc
"review": {
  "mode": "auto",        // off (default) | auto
  "model": "remote",     // optional; defaults to the first available model in routing.remote
  "maxRounds": 2         // reviews per prompt: review, fix, review again
}
```

Turn it on or off for a single prompt without changing config: `/review on|off|default` in the TUI, **Harness: Set Remote Review of Local Edits** in VS Code, or `harness run --review` / `--no-review`.

## What happens

1. The turn runs as usual. Harness notes every file a model edits with `edit` or `write`, including edits by subagents in the same checkout, and remembers each file's content before its first edit.
2. If a **local** model edited anything, the reviewer gets the user's request, the model's closing summary, and a unified diff of the whole turn's changes (capped at 2,000 lines). No tools, no conversation history.
3. The reviewer answers `approve` or `revise`, with a one-sentence summary and specific findings (`file:line`, severity `bug` / `risk` / `nit`, and what to do). A `revise` with only nits counts as an approve.
4. On `revise`, the findings are added to the conversation as a message to the local model, which fixes them (or explains why it disagrees). The fixed diff, still measured from the files' original content, is reviewed again, up to `maxRounds` reviews. Findings from the last review are shown to you but not sent back.

Both clients show each review: `✓ Reviewed by claude-opus-5: approved`, or `↻ claude-opus-5 asked for changes` with the findings listed. The reviewer's call appears as a routing decision with rule `review`, and its cost is recorded under `review` in `harness usage --by rule`.

## When it doesn't run

- No files changed, or only a remote model changed them (it doesn't review its own work).
- The turn didn't finish normally (cancelled, error, out of steps).
- The reviewer is remote and something keeps remote calls off: `routing.mode: local-only`, an organization's remote switch, a spent budget, or a [private session](privacy.md). You'll see `Review skipped:` with the reason.
- `privacy.secrets: block` and the diff contains a secret. With the default `redact`, secrets in the diff are replaced with placeholders first.

A reviewer that fails or returns something unreadable is reported as skipped; the turn itself still succeeds.

## A bigger local model as the reviewer

`review.model` can name any model alias, including a local one. A large local model reviewing a small, fast one costs nothing and works in `local-only` mode:

```jsonc
"models": {
  "fast":  { "provider": "ollama", "model": "qwen3-coder:30b" },
  "large": { "provider": "gpu-box", "model": "qwen3-coder-480b" }
},
"routing": { "local": ["fast"] },
"review": { "mode": "auto", "model": "large" }
```

## Cost

A review costs about one prompt of the diff's size plus a short answer. For a typical change (a 300-line diff, so about 6,000 input tokens with the request and instructions, and about 600 output tokens):

| Reviewer | Per review |
|---|---|
| `claude-opus-5` ($5 / $25 per million) | ~$0.045 |
| `gpt-6-sol` ($2 / $10) | ~$0.018 |
| `deepseek-v4-pro` ($1.32 / $3.96) | ~$0.010 |

For comparison, having `claude-opus-5` write the same change itself, over a dozen tool-using steps with 30,000-token prompts (most of each read from cache), is on the order of $0.70. With `maxRounds: 2`, a change that needs one fix costs two reviews. Prices are the catalog's list prices (checked 2026-09-26); see `packages/providers/src/catalog.ts`.
