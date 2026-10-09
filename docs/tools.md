# Built-in tools

What the model can call, in the fixed order it sees them (the order is part of the prompt-cache prefix, so new tools are only ever appended). MCP servers add more, named `mcp__<server>__<tool>`; see [configuration.md](configuration.md#mcpserversname). Permission categories are explained in [permissions.md](permissions.md).

| Tool | Permission | What it does |
|---|---|---|
| `read` | read | Read a text file, with line numbers; `offset`/`limit` for large files. A PNG, JPEG, GIF, or WebP comes back as the image |
| `glob` | read | Find files by pattern, skipping `node_modules`, `.git`, and build output |
| `grep` | read | Search file contents with a regular expression (ripgrep when installed) |
| `edit` | edit | Replace exact text in a file; the prompt shows a diff |
| `write` | edit | Create or overwrite a file; the prompt shows a diff |
| `bash` | bash | Run a shell command in the [sandbox](permissions.md#sandbox); `background: true` for long-running ones |
| `task` | none | Delegate to a subagent ([subagents.md](subagents.md)) |
| `exit_plan_mode` | none | Present a plan for approval in [plan mode](permissions.md#modes) (top-level sessions only) |
| `bash_output` | none | Read new output from a background shell |
| `kill_shell` | none | Stop a background shell |
| `webfetch` | web | Read a web page as Markdown |
| `websearch` | web | Search the web through the configured backend ([configuration.md](configuration.md#web)) |
| `todo` | none | Keep a checklist for multi-step work; each call replaces the list |
| `skill` | none | Load a [skill](commands-and-skills.md#skills): its instructions, or one of its files |
| `docs` | none | Read Switchback's own documentation, as built into this version: the topics below "Using Switchback" in the docs index, a whole page or one section. The configuration page starts with where this machine's config files are |

An agent definition's `tools` list limits which of these it gets, with some exceptions that aren't capabilities: `bash_output` and `kill_shell` come with `bash`, `exit_plan_mode` comes with every top-level session, and `todo`, `skill`, and `docs` with every session.

## Asking about Switchback

Because every session has `docs`, you can ask the model how Switchback works or to change its settings ("route turns over 50k tokens to the remote model", "allow `bun test` without asking") and it reads the documentation for the version you're running first, offline. It edits the project's `.switchback/config.json` or `.switchback/config.local.json` itself, with the usual permission prompt. Your user config (`~/.switchback/config.json`) is outside the workspace, so for that it tells you what to change. The running engine reads its config when it starts, so a change takes effect after it restarts.

## The checklist

For longer tasks the model keeps a checklist with `todo`: items that are `pending`, `in_progress`, or `done`. Both clients show the latest list above the input while anything on it is unfinished (`☑` done, `▶` in progress, `☐` to do), and leave the calls themselves out of the transcript. The list comes from the conversation, so it's there again when you resume a session.
