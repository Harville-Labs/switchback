#!/usr/bin/env bun
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RoutePreference } from '@harness/protocol';
import { CLI_VERSION } from './bootstrap.ts';

const HELP = `harness ${CLI_VERSION}: local-first coding agent with remote escalation

Usage
  harness [options]               Open the terminal UI in the current directory
  harness run "<prompt>"          Run one prompt headlessly and print the answer
  harness serve --stdio           Serve the engine protocol (used by the VS Code extension)
  harness doctor                  Check configuration, providers, and agents
  harness usage                   Show spend, savings, and budget

Options
  --cwd <dir>        Workspace root (default: current directory)
  --route <r>        auto | local | remote (default: auto)
  --agent <name>     Agent to start with (default: config defaultAgent)
  --yes              run: approve tool permissions without asking
  --json             run/usage: machine-readable output
  --mock             Use scripted mock providers (no models needed)
  -v, --version      Print version
  -h, --help         Print this help
`;

async function main(argv: string[]): Promise<number> {
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
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || values.version) {
    process.stdout.write(values.help ? HELP : `${CLI_VERSION}\n`);
    return 0;
  }

  const route = RoutePreference.safeParse(values.route);
  if (!route.success) {
    process.stderr.write(`harness: --route must be auto, local, or remote\n`);
    return 2;
  }
  const common = { cwd: resolve(values.cwd ?? process.cwd()), mock: values.mock };
  const [command, ...rest] = positionals;

  switch (command) {
    case undefined: {
      const { tui } = await import('./tui/index.tsx');
      return tui({
        ...common,
        route: route.data,
        ...(values.agent ? { agent: values.agent } : {}),
      });
    }
    case 'run': {
      const prompt = rest.join(' ').trim() || (process.stdin.isTTY ? '' : await Bun.stdin.text());
      if (!prompt.trim()) {
        process.stderr.write('harness: run needs a prompt\n');
        return 2;
      }
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
      if (!values.stdio) {
        process.stderr.write('harness: only --stdio is supported today (see docs/protocol.md)\n');
        return 2;
      }
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
    process.stderr.write(`harness: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
