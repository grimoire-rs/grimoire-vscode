import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // Open a folder containing grimoire.toml so project scope is available in
  // integration tests.
  workspaceFolder: './src/test/fixtures/workspace',
  coverage: {
    includeAll: true,
    include: ['dist/extension.js'],
    exclude: ['**/node_modules/**', '**/out/test/**'],
  },
});
