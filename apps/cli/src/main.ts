#!/usr/bin/env bun
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { RemoteKind } from '@switchback/engine';
import { PermissionMode, RoutePreference } from '@switchback/protocol';
import { CLI_VERSION } from './bootstrap.ts';

const MIN_BUN = [1, 4, 0];

const HELP = `switchback ${CLI_VERSION}: local-first coding agent with remote escalation

Usage
  switchback [options]               Open the terminal UI in the current directory
  switchback init                    Set up local and remote models (writes a config file)
  switchback run "<prompt>"          Run one prompt headlessly and print the answer
  switchback config [action]         path | show | schema | edit
  switchback doctor                  Check configuration, providers, and agents
  switchback mcp [trust [name...]]   Show MCP servers; trust a project's servers
  switchback agents [new]            List agents, or create one (interview, optional drafted prompt)
  switchback sessions                List this workspace's saved sessions [--json]
  switchback usage                   Show spend, savings, cache hits, and budget
                                  [--period today|week|month] [--by rule|agent|model]
  switchback telemetry [action]      status | on | off | preview (anonymous, off by default)
  switchback self-update [version]   Update to the newest release (or the given one); --check only reports
  switchback login --site <id>       Sign in to your company's Switchback site (applies its policy)
  switchback logout | whoami         Sign out / show organization and policy
  switchback serve --stdio           Serve the engine protocol to one client over stdin/stdout
  switchback serve --socket          Run this workspace's shared engine (TUI and VS Code attach to it)

Options
  --cwd <dir>        Workspace root (default: current directory)
  --route <r>        auto | local | remote (default: auto)
  --agent <name>     Agent to start with (default: config defaultAgent)
  -c, --continue     Resume the most recent session in this workspace
  -r, --resume       Pick a saved session to resume
  --session <id>     Resume a specific session
  --permission-mode <m>  default | acceptEdits | plan | bypassPermissions
                     (default: permissions.defaultMode)
  --no-daemon        TUI: use a private engine instead of the shared one
  --yes              run: approve tool permissions; init: no prompts
  --json             run/usage/sessions: machine-readable output
  --review, --no-review  run: review of local edits (default: review.mode)
  --mock             Use scripted mock providers (no models needed)
  -v, --version      Print version
  -h, --help         Print this help

init options (all optional; prompts cover anything not given)
  --scope <s>              user | project (default: user)
  --local-url <url>        Local server to probe, e.g. http://gpu-box:8000/v1
  --local-model <name>     Local model name as the server lists it. Repeat for
                           fallbacks and bigger-context models, in order
  --context-window <n>     Tokens the server loads, per --local-model in order
  --start <m>              Where turns start (model ID or alias). Repeat for backups
  --escalate <m[,m]>       An escalation step; repeat for the ladder, in order.
                           Commas make alternatives for one step. Default: the
                           other local models, then hosted ones, cheapest first
  --reviewers <r>          off | ladder (the escalation ladder) | m,m (in order)
  --subagent-model <m>     Default model for subagents
  --no-local               Remote only
  --remote <r>             anthropic | openai | deepseek | gemini | bedrock | vertex |
                           anthropic-aws | foundry | azure-openai | openrouter |
                           openai-compatible | none.
                           Repeat for fallbacks
  --remote-model <m>       Model ID per --remote, in order (see \`switchback init\`)
  --remote-url <url>       openai-compatible: API base URL
  --remote-key-env <var>   openai-compatible, openrouter: env var holding the API key
  --remote-context-window <n>  openai-compatible: context window, when its model
                           listing doesn't say
  --region <r>             Bedrock or Vertex region
  --profile <p>            AWS profile (Bedrock)
  --project-id <id>        GCP project (Vertex)
  --workspace-id <id>      Claude workspace (Claude Platform on AWS)
  --resource <name>        Resource name (Microsoft Foundry, Azure OpenAI)
  --deployment <name>      Azure OpenAI deployment, per --remote-model (default: the model ID)
  --azure-auth <key|entra> Azure OpenAI: API key (default) or Microsoft Entra ID
  --classifier <c>         Rate prompts before routing: jev (TypeSafe Jev), a model, or off
  --policy <p>             Escalation: auto | ask | off
  --telemetry <on|off>     Anonymous usage statistics (default: off; always your user config)
  --daily-budget <usd>     --monthly-budget <usd>

agents new options (prompts cover anything not given; --yes for none)
  --name <n> --description <text> --tools <read,grep,...|all>
  --model <local|remote|alias> --prompt <text> --budget <usd> --isolation worktree

login options
  --site <id>              Your company's site on switchback.harville.ai
  --server <url>           Any organization server (default: previous or $SWITCHBACK_ORG_SERVER)
  --token <token>          Sign in with an access token instead of the browser (CI)
`;

function bunTooOld(): boolean {
  const have = Bun.version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const h = have[i] ?? 0;
    const m = MIN_BUN[i] ?? 0;
    if (h !== m) return h < m;
  }
  return false;
}

const oneOf = <T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined => {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`--${name} must be one of ${allowed.join(', ')}`);
};

const positive = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number`);
  return n;
};

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  if (bunTooOld()) {
    process.stderr.write(
      `switchback: requires Bun ${MIN_BUN.join('.')} or newer (found ${Bun.version}); run \`bun upgrade\`\n`,
    );
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      route: { type: 'string', default: 'auto' },
      agent: { type: 'string' },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      mock: { type: 'boolean', default: false },
      stdio: { type: 'boolean', default: false },
      socket: { type: 'boolean', default: false },
      'no-daemon': { type: 'boolean', default: false },
      continue: { type: 'boolean', short: 'c', default: false },
      resume: { type: 'boolean', short: 'r', default: false },
      session: { type: 'string' },
      'permission-mode': { type: 'string' },
      scope: { type: 'string' },
      'local-url': { type: 'string', multiple: true },
      'local-model': { type: 'string', multiple: true },
      'context-window': { type: 'string', multiple: true },
      start: { type: 'string', multiple: true },
      escalate: { type: 'string', multiple: true },
      reviewers: { type: 'string' },
      'subagent-model': { type: 'string' },
      'no-local': { type: 'boolean', default: false },
      remote: { type: 'string', multiple: true },
      'remote-model': { type: 'string', multiple: true },
      'remote-context-window': { type: 'string' },
      'remote-url': { type: 'string' },
      'remote-key-env': { type: 'string' },
      region: { type: 'string' },
      profile: { type: 'string' },
      'project-id': { type: 'string' },
      'workspace-id': { type: 'string' },
      resource: { type: 'string' },
      deployment: { type: 'string' },
      'azure-auth': { type: 'string' },
      classifier: { type: 'string' },
      policy: { type: 'string' },
      'daily-budget': { type: 'string' },
      'monthly-budget': { type: 'string' },
      server: { type: 'string' },
      site: { type: 'string' },
      token: { type: 'string' },
      by: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      tools: { type: 'string' },
      model: { type: 'string' },
      prompt: { type: 'string' },
      budget: { type: 'string' },
      isolation: { type: 'string' },
      period: { type: 'string' },
      telemetry: { type: 'string' },
      review: { type: 'boolean' },
      'no-review': { type: 'boolean' },
      version: { type: 'boolean', short: 'v', default: false },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || values.version) {
    process.stdout.write(values.help ? HELP : `${CLI_VERSION}\n`);
    return 0;
  }

  const route = RoutePreference.safeParse(values.route);
  if (!route.success) throw new UsageError('--route must be auto, local, or remote');
  const common = { cwd: resolve(values.cwd ?? process.cwd()), mock: values.mock };
  const permissionMode = oneOf(
    'permission-mode',
    values['permission-mode'],
    PermissionMode.options,
  );
  const mode = permissionMode ? { permissionMode } : {};
  const scope = oneOf('scope', values.scope, ['user', 'project'] as const);
  const [command, ...rest] = positionals;

  switch (command) {
    case undefined: {
      if (!common.mock && process.stdin.isTTY) {
        const { needsSetup } = await import('./bootstrap.ts');
        if (needsSetup(common.cwd)) {
          const { offerSetup } = await import('./commands/init.ts');
          const code = await offerSetup(common.cwd);
          if (code !== 0) return code;
        }
      }
      const { tui } = await import('./tui/index.tsx');
      return tui({
        ...common,
        daemon: !values['no-daemon'] && !process.env.SWITCHBACK_NO_DAEMON,
        route: route.data,
        ...mode,
        ...(values.resume ? { pickSession: true } : {}),
        ...(values.agent ? { agent: values.agent } : {}),
        ...(values.session
          ? { resume: values.session }
          : values.continue
            ? { resume: 'latest' }
            : {}),
      });
    }
    case 'init': {
      const { init } = await import('./commands/init.ts');
      const { REMOTE_KINDS } = await import('@switchback/engine');
      const contextWindows = (values['context-window'] ?? []).map(
        (v) => positive('context-window', v) as number,
      );
      const remoteContextWindow = positive(
        'remote-context-window',
        values['remote-context-window'],
      );
      const remotes = (values.remote ?? []).map(
        (v) => oneOf('remote', v, [...REMOTE_KINDS, 'none'] as const) as RemoteKind | 'none',
      );
      const policy = oneOf('policy', values.policy, ['auto', 'ask', 'off'] as const);
      const dailyBudget = positive('daily-budget', values['daily-budget']);
      const monthlyBudget = positive('monthly-budget', values['monthly-budget']);
      return init({
        cwd: common.cwd,
        yes: values.yes,
        noLocal: values['no-local'],
        ...(scope ? { scope } : {}),
        localUrls: values['local-url'] ?? [],
        localModels: values['local-model'] ?? [],
        contextWindows,
        ...(values.start ? { start: values.start } : {}),
        ...(values.escalate ? { escalate: values.escalate } : {}),
        ...(values.reviewers ? { reviewers: values.reviewers } : {}),
        ...(values['subagent-model'] ? { subagentModel: values['subagent-model'] } : {}),
        remotes,
        remoteModels: values['remote-model'] ?? [],
        ...(remoteContextWindow ? { remoteContextWindow } : {}),
        ...(values['remote-url'] ? { remoteUrl: values['remote-url'] } : {}),
        ...(values['remote-key-env'] ? { remoteKeyEnv: values['remote-key-env'] } : {}),
        ...(values.region ? { region: values.region } : {}),
        ...(values.profile ? { profile: values.profile } : {}),
        ...(values['project-id'] ? { projectId: values['project-id'] } : {}),
        ...(values['workspace-id'] ? { workspaceId: values['workspace-id'] } : {}),
        ...(values.resource ? { resource: values.resource } : {}),
        ...(values.deployment ? { deployment: values.deployment } : {}),
        ...(values['azure-auth']
          ? { azureAuth: oneOf('azure-auth', values['azure-auth'], ['key', 'entra'] as const) }
          : {}),
        ...(values.classifier ? { classifier: values.classifier } : {}),
        ...(policy ? { policy } : {}),
        ...(dailyBudget ? { dailyBudget } : {}),
        ...(monthlyBudget ? { monthlyBudget } : {}),
        ...(values.telemetry
          ? { telemetry: oneOf('telemetry', values.telemetry, ['on', 'off'] as const) === 'on' }
          : {}),
      });
    }
    case 'config': {
      const { config } = await import('./commands/config.ts');
      return config(rest[0], { cwd: common.cwd, ...(scope ? { scope } : {}) });
    }
    case 'run': {
      const prompt = rest.join(' ').trim() || (process.stdin.isTTY ? '' : await Bun.stdin.text());
      if (!prompt.trim()) throw new UsageError('run needs a prompt');
      const { run } = await import('./commands/run.ts');
      return run({
        ...common,
        prompt,
        route: route.data,
        yes: values.yes,
        json: values.json,
        ...mode,
        ...(values.review ? { review: true } : values['no-review'] ? { review: false } : {}),
        ...(values.agent ? { agent: values.agent } : {}),
      });
    }
    case 'serve': {
      if (values.stdio === values.socket)
        throw new UsageError(
          'serve needs exactly one of --stdio or --socket (see docs/protocol.md)',
        );
      if (values.socket && values.mock)
        throw new UsageError('a shared daemon never runs mock providers; use --stdio with --mock');
      const { serve } = await import('./commands/serve.ts');
      return serve({ ...common, socket: values.socket });
    }
    case 'agents': {
      const { agents } = await import('./commands/agents.ts');
      const budget = positive('budget', values.budget);
      const isolation = oneOf('isolation', values.isolation, ['worktree', 'none'] as const);
      return agents(rest[0], {
        ...common,
        yes: values.yes,
        ...(scope ? { scope } : {}),
        ...(values.name ? { name: values.name } : {}),
        ...(values.description ? { description: values.description } : {}),
        ...(values.tools !== undefined ? { tools: values.tools } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.prompt ? { prompt: values.prompt } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(isolation ? { isolation: isolation === 'worktree' } : {}),
      });
    }
    case 'mcp': {
      const { mcp } = await import('./commands/mcp.ts');
      return mcp(rest[0], rest.slice(1), common);
    }
    case 'doctor': {
      const { doctor } = await import('./commands/doctor.ts');
      return doctor(common);
    }
    case 'login': {
      const { login } = await import('./commands/org.ts');
      return login({
        cwd: common.cwd,
        ...(values.server ? { server: values.server } : {}),
        ...(values.site ? { site: values.site } : {}),
        ...(values.token ? { token: values.token } : {}),
      });
    }
    case 'logout': {
      const { logout } = await import('./commands/org.ts');
      return logout();
    }
    case 'whoami': {
      const { whoami } = await import('./commands/org.ts');
      return whoami(common.cwd);
    }
    case 'self-update':
    case 'selfupdate': {
      if (rest.length > 1) throw new UsageError('self-update takes at most one version');
      const { selfUpdate } = await import('./commands/self-update.ts');
      return selfUpdate({ ...(rest[0] ? { version: rest[0] } : {}), check: values.check });
    }
    case 'telemetry': {
      const { telemetry } = await import('./commands/telemetry.ts');
      return telemetry(rest[0], common);
    }
    case 'sessions': {
      const { sessions } = await import('./commands/sessions.ts');
      return sessions({ ...common, json: values.json });
    }
    case 'usage': {
      const { usage } = await import('./commands/usage.ts');
      return usage({
        ...common,
        json: values.json,
        ...(values.by ? { by: values.by } : {}),
        ...(values.period ? { period: values.period } : {}),
      });
    }
    default:
      process.stderr.write(`switchback: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

/** With telemetry on, keep a scrubbed record of the crash for the next report. */
async function recordCrashIfEnabled(err: unknown): Promise<void> {
  try {
    const { loadConfig, switchbackPaths, recordCrash } = await import('@switchback/engine');
    if (loadConfig(process.cwd(), process.env).config.telemetry.enabled)
      recordCrash(switchbackPaths().dataDir, err, new Date());
  } catch {
    // Reporting a crash must never cause another one.
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  async (err) => {
    if (
      err instanceof UsageError ||
      (err as { code?: string })?.code?.startsWith('ERR_PARSE_ARGS')
    ) {
      process.stderr.write(`switchback: ${(err as Error).message}\n`);
      process.exit(2);
    }
    process.stderr.write(`switchback: ${(err as Error).stack ?? err}\n`);
    await recordCrashIfEnabled(err);
    process.exit(1);
  },
);
