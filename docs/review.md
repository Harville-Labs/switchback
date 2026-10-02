# Review with a stronger model

An optional workflow: one model writes the code, and others review what it changed. When a reviewer finds a real problem, the findings go back to the writing model to fix, and the fix is reviewed again. Reviewers are any models, local or remote, in order: a free local reviewer can check every change, and a stronger one steps in only when the first one's findings don't get fixed.

Writing code with a remote model is expensive because every step resends the growing conversation. Reviewing is cheap: the reviewer sees one diff and answers with a short verdict. You get most of the stronger model's judgment for a fraction of its cost.

```jsonc
"review": {
  "mode": "auto",                 // off (default) | auto
  "models": ["large", "opus"],    // reviewers in order; default: the routing.escalate ladder
  "maxRounds": 3                  // reviews per prompt, across all reviewers (1 to 6)
}
```

Turn it on or off for a single prompt without changing config: `/review on|off|default` in the TUI, **Switchback: Set Review of Local Edits** in VS Code, or `switchback run --review` / `--no-review`.

## What happens

1. The turn runs as usual. Switchback notes every file a model edits with `edit` or `write`, including edits by subagents in the same checkout, remembers each file's content before its first edit, and which models edited it.
2. If anything was edited, the first reviewer gets the user's request, the model's closing summary, and a unified diff of the whole turn's changes (capped at 2,000 lines). No tools, no conversation history.
3. The reviewer answers `approve` or `revise`, with a one-sentence summary and specific findings (`file:line`, severity `bug` / `risk` / `nit`, and what to do). A `revise` with only nits counts as an approve.
4. On `revise`, the findings are added to the conversation as a message to the writing model, which fixes them (or explains why it disagrees). The fixed diff, still measured from the files' original content, is reviewed again.
5. **The review ladder.** Each reviewer gets one fix to satisfy it. If its findings still stand after that fix, the next reviewer in `review.models` takes over. Reviews stop at the first approve, or after `maxRounds`. Findings from the last review are shown to you but not sent back.

With `"models": ["large", "opus"]` and the default 3 rounds, a change that `large` approves costs nothing. One that `large` still rejects after a fix gets a third review from `opus`, which costs about a cent.

`review.models` is a list like `routing.escalate`: each entry is a reviewer, or a chain of alternatives for the same place in the ladder (`[["opus", "sol"]]`: the first that's up). Left empty, it's the `routing.escalate` ladder itself, so the models a turn would escalate to are the ones that review it.

Both clients show each review: `✓ Reviewed by claude-opus-5: approved`, or `↻ large asked for changes` with the findings listed. Each reviewer's call appears as a routing decision with rule `review`, and its cost is recorded under `review` in `switchback usage --by rule`.

## Who reviews

Each round, the first reviewer from the current place in the ladder that:

- **didn't write the change.** A model never reviews its own work. If the start model and a reviewer are the same model, that reviewer is passed over.
- **is up.**
- **if remote, is allowed:** not with `routing.allowRemote: false`, an organization's remote switch, a spent budget, or a [private session](privacy.md). Local reviewers are free and always allowed, so private and offline sessions can still be reviewed.

When no reviewer qualifies, you'll see `Review skipped:` with the reason (for example `opus wrote the change, and a model never reviews its own work`).

## When it doesn't run

- No files changed, or no reviewer qualifies (above).
- The turn didn't finish normally (cancelled, error, out of steps).
- `privacy.secrets: block` and the diff contains a secret, for a remote reviewer. With the default `redact`, secrets in the diff are replaced with placeholders first.

A reviewer that fails or returns something unreadable is reported as skipped; the turn itself still succeeds.

## Setting it up

`switchback init` asks whether to review edits automatically and with which models, and `--reviewer remote|<model name>` sets it unattended. Any alias works in `review.models`:

```jsonc
"models": {
  "fast":  { "provider": "ollama", "model": "qwen3-coder:30b" },
  "large": { "provider": "gpu-box", "model": "qwen3-coder-480b" },
  "opus":  { "provider": "anthropic", "model": "claude-opus-5" }
},
"routing": { "start": ["fast"], "escalate": ["large", "opus"] },
"review": { "mode": "auto" }      // reviewers: large, then opus
```

## Cost

A review costs about one prompt of the diff's size plus a short answer. For a typical change (a 300-line diff, so about 6,000 input tokens with the request and instructions, and about 600 output tokens):

| Reviewer | Per review |
|---|---|
| `claude-opus-5` ($5 / $25 per million) | ~$0.045 |
| `gpt-6-sol` ($2 / $10) | ~$0.018 |
| `deepseek-v4-pro` ($1.32 / $3.96) | ~$0.010 |

For comparison, having `claude-opus-5` write the same change itself, over a dozen tool-using steps with 30,000-token prompts (most of each read from cache), is on the order of $0.70. With `maxRounds: 2`, a change that needs one fix costs two reviews. Prices are the catalog's list prices (checked 2026-09-26); see `packages/providers/src/catalog.ts`.
