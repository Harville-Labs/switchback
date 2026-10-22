# Built-in tools

What the model can call, in the fixed order it sees them (the order is part of the prompt-cache prefix, so new tools are only ever appended). MCP servers add more, named `mcp__<server>__<tool>`; see [configuration.md](configuration.md#mcpserversname). Permission categories are explained in [permissions.md](permissions.md).

| Tool | Permission | What it does |
|---|---|---|
| `read` | read | Read a text file, with line numbers; `offset`/`limit` for large files. A PNG, JPEG, GIF, or WebP comes back as the image. A directory comes back as its entries, folders first (up to 500), without what deny rules hide |
| `glob` | read | Find files by pattern, skipping `node_modules`, `.git`, and build output |
| `grep` | read | Search file contents with a regular expression (ripgrep when installed). `context` adds up to 20 lines around each match; `filesOnly` returns just the paths that match |
| `edit` | edit | Replace exact text in a file; the prompt shows a diff |
| `write` | edit | Create or overwrite a file; the prompt shows a diff |
| `bash` | bash | Run a shell command in the [sandbox](permissions.md#sandbox); `background: true` for long-running ones |
| `task` | none | Delegate to a subagent ([subagents.md](subagents.md)). Several calls in one response run in parallel, up to `subagents.maxConcurrent` |
| `exit_plan_mode` | none | Present a plan for approval in [plan mode](permissions.md#modes) (top-level sessions only) |
| `bash_output` | none | Read new output from a background shell |
| `kill_shell` | none | Stop a background shell |
| `webfetch` | web | Read a web page as Markdown |
| `websearch` | web | Search the web through the configured backend, or Exa when none is set ([configuration.md](configuration.md#web)) |
| `todo` | none | Keep a checklist for multi-step work; each call replaces the list |
| `skill` | none | Load a [skill](commands-and-skills.md#skills): its instructions, or one of its files |
| `merge_worktree` | edit (always asks) | Merge a branch an [isolated subagent](subagents.md#worktree-isolation) left into your checked-out branch, after you see the diff |
| `escalate` | none | Ask for the next step to run one model up the escalation ladder, with a reason; the router decides under `escalation.policy` ([routing.md](routing.md#the-model-escalating-itself)) |
| `goal` | none | End the goal the user set with `/goal`: `done` when it's met, `blocked` when the model needs the user, with a summary the user sees (top-level sessions only; [ADR 0024](adr/0024-goals.md)) |
| `docs` | none | Read Switchback's own documentation, as built into this version: the topics below "Using Switchback" in the docs index, a whole page or one section. The configuration page starts with where this machine's config files are |
| `models` | none | List the configured models: alias, tier, context window, price, and the role each fills in this session. A model passes an alias as `task`'s `model` to pick a subagent's model |
| `config` | none | Read the configuration in effect (user, project, and organization files merged, defaults filled in), one key or section at a time. API keys, tokens, and every `headers` and `env` value are hidden |
| `set_config` | edit (always asks) | Set or remove one key in the user, project, or local config file, keeping its comments. You see the diff first; a change that would make the file invalid, or touch a key the organization sets, fails before you're asked. It takes effect at once |
| `set_roles` | edit (always asks) | Change this session's current models, escalation ladder, review, or subagent model, as `/ladder` and `/models` do; `save: true` also makes them the default (top-level sessions only) |

An agent definition's `tools` list limits which of these it gets, with some exceptions that aren't capabilities: `bash_output` and `kill_shell` come with `bash`, `merge_worktree` with `task`, `set_config` with `edit`, `exit_plan_mode`, `goal`, and `set_roles` come with every top-level session, and `todo`, `skill`, `docs`, `escalate`, `models`, and `config` with every session.

A model with less than 32k tokens of context gets a smaller list, so the tool schemas don't crowd its window: `merge_worktree`, `models`, `config`, `set_config`, and `set_roles` are left out. It can `escalate` when it needs one, and you can change models with `/ladder` and `/models`. Without `set_config` it changes settings by editing the config file, which applies after `/reload`. The rest keep their order, so each model's prompt prefix stays stable.

## How much of a result the model gets

Every tool result, MCP tools' and subagents' reports included, is cut to fit the context window of the model that made the call. All the results of one step share a quarter of that window (at about 3 characters a token), split evenly between parallel calls, with no result cut below 2,000 characters or kept past 30,000. A cut result keeps its start and its last lines, which say how it ended (a command's exit code, how many lines a read left out), and tells the model to ask for less: a line range, a narrower pattern. On an 8k-token local model one read keeps about 6,000 characters; on a 200k-token model, 30,000. The privacy check and hooks see the whole result before it is cut.

## Asking about Switchback

Because every session has `docs`, you can ask the model how Switchback works or to change its settings ("route turns over 50k tokens to the remote model", "allow `bun test` without asking") and it reads the documentation for the version you're running first, offline. It reads the settings in effect with `config` and `models`, then changes them with `set_config` in the project's `.switchback/config.json` or `.switchback/config.local.json`, or your user config (`~/.switchback/config.json`), or with `set_roles` for the session's models and escalation ladder. You're asked every time, even in `acceptEdits`, `autoApprove`, or with `edit: "allow"`, and a change that would make the config invalid fails before you're asked. A change made this way takes effect at once ([ADR 0028](adr/0028-agents-change-their-settings.md)). A config file edited with `edit` or `write` is checked the same way ([permissions.md](permissions.md#outside-the-workspace)), but the running engine doesn't watch its files, so that change takes effect when you type `/reload` or with the next engine.

## The checklist

For longer tasks the model keeps a checklist with `todo`: items that are `pending`, `in_progress`, or `done`. Both clients show the latest list above the input while anything on it is unfinished (`☑` done, `▶` in progress, `☐` to do), and leave the calls themselves out of the transcript. The list comes from the conversation, so it's there again when you resume a session.
