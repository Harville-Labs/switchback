#!/usr/bin/env bun
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RoutePreference } from '@harness/protocol';
import { CLI_VERSION } from './bootstrap.ts';

const MIN_BUN = [1, 4, 0];

const HELP = `harness ${CLI_VERSION}: local-first coding agent with remote escalation

Usage
  harness [options]               Open the terminal UI in the current directory
  harness init                    Set up local and remote models (writes a config file)
  harness run "<prompt>"          Run one prompt headlessly and print the answer
  harness config [action]         path | show | schema | edit
  harness doctor                  Check configuration, providers, and agents
  harness usage                   Show spend, savings, and budget
  harness serve --stdio           Serve the engine protocol (used by the VS Code extension)

Options
  --cwd <dir>        Workspace root (default: current directory)
  --route <r>        auto | local | remote (default: auto)
  --agent <name>     Agent to start with (default: config defaultAgent)
  -c, --continue     Resume the most recent session in this workspace
  --session <id>     Resume a specific session
  --yes              run: approve tool permissions; init: no prompts
  --json             run/usage: machine-readable output
  --mock             Use scripted mock providers (no models needed)
  -v, --version      Print version
  -h, --help         Print this help

init options (all optional; prompts cover anything not given)
  --scope <s>              user | project (default: user)
  --local-url <url>        Local server, e.g. http://localhost:11434/v1
  --local-model <name>     Local model name as the server lists it
  --context-window <n>     Tokens the local server loads
  --no-local               Remote only
  --remote <r>             anthropic | bedrock | vertex | none
  --remote-model <m>       claude-opus-5 | claude-sonnet-5 | claude-haiku-4-5
  --region <r>             Bedrock or Vertex region
  --profile <p>            AWS profile (Bedrock)
  --project-id <id>        GCP project (Vertex)
  --policy <p>             Escalation: auto | ask | off
  --daily-budget <usd>     --monthly-budget <usd>
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
      `harness: requires Bun ${MIN_BUN.join('.')} or newer (found ${Bun.version}); run \`bun upgrade\`\n`,
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
      continue: { type: 'boolean', short: 'c', default: false },
      session: { type: 'string' },
      scope: { type: 'string' },
      'local-url': { type: 'string' },
      'local-model': { type: 'string' },
      'context-window': { type: 'string' },
      'no-local': { type: 'boolean', default: false },
      remote: { type: 'string' },
      'remote-model': { type: 'string' },
      region: { type: 'string' },
      profile: { type: 'string' },
      'project-id': { type: 'string' },
      policy: { type: 'string' },
      'daily-budget': { type: 'string' },
      'monthly-budget': { type: 'string' },
      version: { type: 'boolean', short: 'v', default: false },
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
        route: route.data,
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
      const contextWindow = positive('context-window', values['context-window']);
      const remote = oneOf('remote', values.remote, [
        'anthropic',
        'bedrock',
        'vertex',
        'none',
      ] as const);
      const policy = oneOf('policy', values.policy, ['auto', 'ask', 'off'] as const);
      const dailyBudget = positive('daily-budget', values['daily-budget']);
      const monthlyBudget = positive('monthly-budget', values['monthly-budget']);
      return init({
        cwd: common.cwd,
        yes: values.yes,
        noLocal: values['no-local'],
        ...(scope ? { scope } : {}),
        ...(values['local-url'] ? { localUrl: values['local-url'] } : {}),
        ...(values['local-model'] ? { localModel: values['local-model'] } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(remote ? { remote } : {}),
        ...(values['remote-model'] ? { remoteModel: values['remote-model'] } : {}),
        ...(values.region ? { region: values.region } : {}),
        ...(values.profile ? { profile: values.profile } : {}),
        ...(values['project-id'] ? { projectId: values['project-id'] } : {}),
        ...(policy ? { policy } : {}),
        ...(dailyBudget ? { dailyBudget } : {}),
        ...(monthlyBudget ? { monthlyBudget } : {}),
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
        ...(values.agent ? { agent: values.agent } : {}),
      });
    }
    case 'serve': {
      if (!values.stdio)
        throw new UsageError('only --stdio is supported today (see docs/protocol.md)');
      const { serve } = await import('./commands/serve.ts');
      return serve(common);
    }
    case 'doctor': {
      const { doctor } = await import('./commands/doctor.ts');
      return doctor(common);
    }
    case 'usage': {
      const { usage } = await import('./commands/usage.ts');
      return usage({ ...common, json: values.json });
    }
    default:
      process.stderr.write(`harness: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (
      err instanceof UsageError ||
      (err as { code?: string })?.code?.startsWith('ERR_PARSE_ARGS')
    ) {
      process.stderr.write(`harness: ${(err as Error).message}\n`);
      process.exit(2);
    }
    process.stderr.write(`harness: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
