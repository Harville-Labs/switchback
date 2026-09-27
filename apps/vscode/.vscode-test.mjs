import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

// Integration tests run inside a real VS Code with the extension loaded.
const base = {
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  env: { HARNESS_HOME: mkdtempSync(join(tmpdir(), 'harness-vscode-test-')) },
};

export default defineConfig([
  {
    // Against the dev CLI in --mock mode (test/fixture/.vscode/settings.json).
    label: 'dev',
    files: 'out/test/**/*.itest.js',
    workspaceFolder: './test/fixture',
    mocha: { ui: 'tdd', timeout: 60_000 },
    ...base,
  },
  {
    // No settings: the extension must use the engine bundled in bin/ (as shipped).
    label: 'bundled',
    files: 'out/test/extension.itest.js',
    workspaceFolder: './test/fixture-bundled',
    mocha: { ui: 'tdd', timeout: 60_000, grep: 'activates' },
    ...base,
  },
]);
