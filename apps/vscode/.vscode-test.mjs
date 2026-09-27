import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

// Integration tests run inside a real VS Code with the extension loaded,
// talking to the dev CLI in --mock mode (see test/fixture/.vscode/settings.json).
export default defineConfig({
  files: 'out/test/**/*.test.js',
  workspaceFolder: './test/fixture',
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  env: { HARNESS_HOME: mkdtempSync(join(tmpdir(), 'harness-vscode-test-')) },
  mocha: { ui: 'tdd', timeout: 60_000 },
});
