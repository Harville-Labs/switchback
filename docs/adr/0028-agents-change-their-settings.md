# 0028: The model reads and changes Switchback's settings with tools

**Status:** Accepted · 2026-10-22

## Context

Users ask the model to change Switchback itself: "never escalate this session", "add the 70b model to the ladder", "run subagents on the local model". Before, the model could only read the docs and edit the config files with `edit`. It couldn't see the configuration in effect (the merge of user, project, and organization files with defaults), so it guessed at keys and didn't know which models existed or which role each filled. An edit to a config file took effect only after `/reload`, and the session's roles (what `/ladder` and `/models` change) had no file to edit at all. To pick a model for a subagent, it had to know aliases it couldn't list.

## Decision

- **Reading is free.** Every session gets `models` and `config`, with permission `none`. `models` lists aliases, tiers, context windows, prices, and the role each model fills in this session. `config` returns the configuration in effect, one key or section at a time, through the same `redactConfig` as `switchback config show`: API keys, tokens, and every `headers` and `env` value are hidden, since `{env:NAME}` has already been substituted by then.
- **Changing always asks.** `set_config` sets or removes one key in the user, project, or local file, keeping comments. `set_roles` changes the session's roles through the same engine call as `session.setRoles`, and can save them as the default. The permission gate's `mustAsk` asks for both in every mode except `bypassPermissions`, including `acceptEdits`, `autoApprove`, and `edit: "allow"`, as it already did for edits under `.switchback/`. Plan mode refuses them as edits.
- **Checked before the prompt, applied after it.** `set_config` validates the file it would write and refuses org-enforced keys before the user is asked. After approval it writes the file and reloads the engine, so the change applies at once. If the reload fails, the old file is put back.
- **Scope.** `set_config` comes with the `edit` capability. `set_roles` is top-level only, like `exit_plan_mode` and `goal`: a subagent shouldn't change the routing of the session that started it.

## Consequences

- A model can describe and change routing accurately, and pass a real alias as `task`'s `model`.
- The four tools add about 1,000 tokens to the tool list. A model with less than 32k of context doesn't get them, nor `merge_worktree`; it escalates for those, and the user has `/ladder` and `/models`. It keeps `webfetch`, `websearch`, and `docs`, and can still change a setting by editing the file, which applies after `/reload`.
- Changing settings costs one approval per change. That is deliberate: these settings decide where calls go and what they cost (invariant 10).
- Two ways to change a config file remain: `set_config`, which applies at once, and `edit`, which waits for `/reload`.
