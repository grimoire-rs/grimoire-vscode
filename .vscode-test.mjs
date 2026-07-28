import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // Open a folder containing grimoire.toml so project scope is available in
  // integration tests.
  workspaceFolder: './src/test/fixtures/workspace',
  mocha: {
    // Every test here drives a real VS Code: activating the extension,
    // writing global settings, spawning a stub `grim`. Mocha's 2s default is
    // a unit-test budget and is simply wrong for that — it passed on Linux
    // and timed out on a cold macOS runner, in tests and in `suiteTeardown`
    // hooks that had no `this.timeout()` of their own. Setting the floor
    // once beats discovering the next borderline hook in CI. Individual
    // slow tests still raise it further with `this.timeout(60000)`.
    timeout: 30000,
  },
  coverage: {
    includeAll: true,
    include: ['dist/extension.js'],
    exclude: ['**/node_modules/**', '**/out/test/**'],
  },
});
