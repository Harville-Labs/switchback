# Custom commands and skills

Three ways to give Switchback your own instructions in files:

- **`AGENTS.md`** holds standing instructions that go into every session: how to build and test, conventions, things not to do.
- A **custom command** is a prompt you run by name: `/fix-issue 12`.
- A **skill** is know-how the model loads when a task calls for it: how your team writes release notes, how to fill in a PDF form, how to cut a release.

Commands and skills live in Switchback's own folders, in the project (shared with your team through git) or in your user config (yours, in every project). When a project and you both define the same name, the project's wins. Switchback rescans these folders as it uses them, so new files work without a restart.

## AGENTS.md

| Where | Scope |
|---|---|
| `AGENTS.md` at the workspace root | This project, shared with your team through git |
| `~/.switchback/AGENTS.md` | You, in every project |

Both go into every session's system prompt, subagents included: yours under **User instructions**, then the project's under **Project instructions**, so the project's more specific instructions come last. Switchback reads only these two files ([open conventions](adr/0016-open-conventions.md)), never another tool's. Edits take effect without a restart, in every session on the machine. New sessions start with the current text. A running session gets the change with your next message, as a note to the model that replaces that section of its instructions. Its system prompt isn't rewritten, so the provider's prompt cache keeps working. A turn already in progress finishes under the instructions it started with.

Every session pays for them in context, subagents included. `switchback doctor` shows each file's size in tokens and warns when together they take more than 10% of your smallest local model's context window. Keep them to rules that apply to every task, and move how-to detail into [skills](#skills), which load only when needed.

## Custom commands

| Where | Scope |
|---|---|
| `.switchback/commands/<name>.md` | This project |
| `~/.switchback/commands/<name>.md` | You, everywhere |

The file name is the command: lowercase letters, digits, and dashes. The body is the prompt. Frontmatter is optional:

```markdown
---
description: Fix a GitHub issue end to end
args: <issue> [notes]
---
Fix issue #$1. Read it with `gh issue view $1`, find the cause, fix it,
and add a test. Extra notes from me: $ARGUMENTS
```

- `$ARGUMENTS` is everything typed after the name; `$1` to `$9` are its words. Placeholders with nothing to fill them become empty.
- `description` shows in the command menus. Without it, the menus show the first line of the prompt.
- `args` is the hint shown after the name. When it starts with `<`, choosing the command in a menu waits for you to type the argument instead of running it.

Type `/` in the TUI or the VS Code chat to see your commands under **Custom**, after the built-in ones. A built-in command keeps its name: a custom command called `help` or `usage` is ignored. Headless runs take them too: `switchback run "/fix-issue 12"`.

The engine expands the command, so the transcript (and the model) sees the prompt it makes. Clients list commands with `commands.list` ([protocol.md](protocol.md)).

## MCP prompts

Prompts from [MCP servers](configuration.md#mcpserversname) are commands too, named `<server>:<prompt>` (`/github:review-pr 123`), and listed under **Custom** with `(mcp)` after their description. Words after the name fill the prompt's arguments in order; the last argument takes the rest of the line. A prompt missing a required argument says which it needs.

## Skills

Skills use the open [Agent Skills](https://agentskills.io) format: a folder with a `SKILL.md`, plus any scripts, templates, or reference files the skill needs.

| Where | Scope |
|---|---|
| `.switchback/skills/<name>/SKILL.md` | This project |
| `~/.switchback/skills/<name>/SKILL.md` | You, everywhere |

```markdown
---
name: release-notes
description: Write release notes from merged PRs. Use when asked for release notes or a changelog entry.
---
1. List the PRs merged since the last tag with `gh pr list --state merged --search "merged:>DATE"`.
2. Group them by Added / Changed / Fixed, following template.md.
...
```

`name` (lowercase letters, digits, and dashes; the folder name when it's missing) and `description` are required. The description is what the model decides from, so say what the skill does and when to use it.

When a session starts, every skill's name and description go into its system prompt under **# Skills**. The rest stays on disk until the model calls the `skill` tool, which returns the instructions in `SKILL.md` and lists the folder's other files; the model loads those by name with the same tool (`file: "template.md"`). An unused skill costs one line of context.

Loading a skill needs no permission: it reads only the skill's own folder, and paths can't leave it. Running a skill's scripts goes through `bash` like any other command, with the usual [permissions](permissions.md) and [sandbox](permissions.md#sandbox).

The skills list is fixed when a session starts (the system prompt never changes mid-session, which keeps provider caches valid). A skill you add shows up in the next session.

## Not read

Switchback reads only its own folders. It doesn't read other agents' command or skill directories (`.claude/commands`, `.claude/skills`, and the like); copy or symlink the ones you want into `.switchback/`. See [ADR 0016](adr/0016-open-conventions.md).
