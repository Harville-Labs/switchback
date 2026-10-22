# 0024: An auto-approve mode where a model judges calls

**Status:** Accepted · 2026-10-22

## Context

People said Switchback asks too often. The existing answers are coarse: `acceptEdits` approves every edit and nothing else, `bypassPermissions` approves everything, and allow rules have to be written ahead of time. Most prompts in a working session are for calls that obviously follow from the request, such as running the tests the user asked to fix. Some aren't, such as a push or an `rm -rf`, and those are the ones a prompt is for.

## Decision

- A new permission mode, `autoApprove`, sits between `acceptEdits` and `plan` in the Shift+Tab order.
- In it, a call that would ask because of its category's level goes to a model first. The model sees the user's latest message and the call, and answers with JSON: approve or not, and one sentence why. Approved calls run; everything else asks the user, with the model's reason.
- The judge can only remove a prompt. Deny rules, ask rules, leaving the sandbox, edits outside the workspace, and edits to Switchback's own configuration behave as in `default`. A failed or unreadable judgment asks.
- The judge is `permissions.judge` if set, else the session's first available local model. Unset, it never picks a remote model, so the mode never silently costs money (invariant 10). A remote judge runs only while remote calls are allowed, is recorded in the ledger under the rule `auto-approve`, and gets secrets redacted.
- Each judgment is a `permission.judged` event. Clients show approved calls in the transcript, so the user can see what ran without them.

## Consequences

- Fewer prompts, at the cost of trusting a model's reading of the request. A prompt-injected file can try to talk the judge into approving a call; deny rules and the always-ask cases above stay the hard limits.
- Each judged call costs one short model request, which adds latency on a slow local model.
- An organization that rules out `bypassPermissions` doesn't rule out `autoApprove`. If that need comes up, it gets its own restriction.
