/** `switchback --help`. */
import { CLI_VERSION } from './bootstrap.ts';

export const HELP = `switchback ${CLI_VERSION}: local-first coding agent with remote escalation

Usage
  switchback [options]               Open the terminal UI in the current directory
  switchback init                    Open the terminal UI on setup: local and remote models
  switchback resume [id]             Open the terminal UI on a saved session, or pick one from a list
  switchback run "<prompt>"          Run one prompt headlessly and print the answer
  switchback config [action]         path | show | schema | edit
  switchback doctor                  Check configuration, providers, and agents
  switchback mcp [trust [name...]]   Show MCP servers; trust a project's servers
  switchback hooks [trust]           Show hooks; trust a project's hooks
  switchback agents [new]            List agents, or create one (interview, optional drafted prompt)
  switchback sessions                List this workspace's saved sessions [--json]
  switchback worktrees [branch]      Branches isolated subagents made, or one branch's diff [--json]
  switchback usage                   Spend, savings, cache hits, and budget (interactive in a terminal)
                                  [--period today|week|month|year|all] [--from <day> [--to <day>]]
                                  [--by rule|agent|model] [--json]
  switchback telemetry [action]      status | on | off | preview (anonymous, off by default)
  switchback sandbox [action]        install | uninstall: the command sandbox's one-time setup (Windows)
  switchback self-update [version]   Update to the newest release (or the given one); --check only reports
                                    Aliases: selfupdate, upgrade, update
  switchback login --site <id>       Sign in to your company's Switchback site (applies its policy)
  switchback logout | whoami         Sign out / show organization and policy
  switchback serve --stdio           Serve the engine protocol to one client over stdin/stdout
  switchback serve --socket          Run this workspace's shared engine (TUI and VS Code attach to it)
  switchback acp                     Run as an Agent Client Protocol agent over stdin/stdout (Zed, JetBrains, ...)

Options
  --cwd <dir>        Workspace root (default: current directory)
  --route <r>        auto | local | remote (default: auto)
  --agent <name>     Agent to start with (default: config defaultAgent)
  -c, --continue     Resume the most recent session in this workspace
  -r, --resume [id]  Same as \`switchback resume [id]\`
  --session <id>     Resume a specific session
  --permission-mode <m>  default | acceptEdits | plan | bypassPermissions
  --effort <e>       Reasoning effort for the session: none | low | medium | high | xhigh | max
                     (default: permissions.defaultMode)
  --no-daemon        TUI: use a private engine instead of the shared one
  --yes              run: approve tool permissions; init: no prompts
  --json             usage/sessions: machine-readable output
  --review, --no-review  run: review of local edits (default: review.mode)

run options (scripts and CI; the prompt can also come on stdin)
  --output <o>             text (default) | json (one result object) | events (NDJSON)
  --allow <rule>           Allow rule for this run, e.g. "bash(bun test:*)"; repeat
  --deny <rule>            Deny rule for this run, e.g. "webfetch"; repeat
  --max-steps <n>          At most n model calls
  --instructions <text>    Added to this run's system prompt
  -c, --continue / --session <id>  Continue a saved session
  Exit codes: 0 done, 1 failed, 2 usage error, 3 finished but a tool call was refused
  --mock             Use scripted mock providers (no models needed)
  -v, --version      Print version
  -h, --help         Print this help

init options (any of these asks the rest as terminal prompts; with --yes, none)
  --scope <s>              user | project (default: user)
  --from <agent>           Start from another agent's setup: opencode (asked on
                           a first run when its config is found)
  --local-url <url>        Local server to probe, e.g. http://gpu-box:8000/v1
  --local-model <name>     Local model name as the server lists it. Repeat for
                           fallbacks and bigger-context models, in order
  --context-window <n>     Tokens the server loads, per --local-model in order
  --current <m>            The current model, where turns start (model ID or
                           alias). Repeat for backups. --start still works
  --escalate <m[,m]>       An escalation step; repeat for the ladder, in order.
                           Commas make alternatives for one step. Default: the
                           other local models, then hosted ones, cheapest first
  --reviewers <r>          off | ladder (the escalation ladder) | m,m (in order)
  --subagent-model <m>     Default model for subagents
  --no-local               Remote only
  --remote <r>             anthropic | openai | deepseek | gemini | bedrock | vertex |
                           anthropic-aws | foundry | azure-openai | openrouter |
                           openai-compatible | none. Repeat for fallbacks
  --remote-model <m>       Model ID per --remote, in order (see \`switchback init\`)
  --remote-url <url>       openai-compatible: API base URL
  --remote-key-env <var>   openai-compatible, openrouter: env var holding the API key
  --remote-context-window <n>  openai-compatible: context window, when its listing doesn't say
  --region <r>             Bedrock or Vertex region
  --profile <p>            AWS profile (Bedrock)
  --project-id <id>        GCP project (Vertex)
  --workspace-id <id>      Claude workspace (Claude Platform on AWS)
  --resource <name>        Resource name (Microsoft Foundry, Azure OpenAI)
  --deployment <name>      Azure OpenAI deployment, per --remote-model (default: the model ID)
  --azure-auth <key|entra> Azure OpenAI: API key (default) or Microsoft Entra ID
  --opencode-plan <go|zen> OpenCode: Go subscription (default) or Zen pay as you go
  --policy <p>             Escalation: auto | ask | off
  --telemetry <on|off>     Anonymous usage statistics (default: off; always your user config)
  --daily-budget <usd>     --monthly-budget <usd>

agents new options (prompts cover anything not given; --yes for none)
  --name <n> --description <text> --tools <read,grep,...|all>
  --model <local|remote|alias> --prompt <text> --budget <usd> --isolation worktree

login options
  --site <id>              Your company's site on app.switchback.sh
  --server <url>           Any organization server (default: previous or $SWITCHBACK_ORG_SERVER)
  --token <token>          Sign in with an access token instead of the browser (CI)
`;
