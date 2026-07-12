// Build script for the mocha test suite. lit-html is ESM-only, so the old
// `tsc -p tsconfig.test.json` CJS emit can no longer require() it — each
// src/test/*.test.ts is bundled by esbuild instead (platform node picks the
// node/default export condition, same as the host bundle in esbuild.js).
// Type-checking of tests is covered by `npm run check-types` (root tsconfig
// includes src); this script only produces runnable out/test/*.test.js.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, 'src', 'test');
const entryPoints = {};
for (const file of fs.readdirSync(testDir)) {
  if (file.endsWith('.test.ts')) {
    entryPoints[file.slice(0, -'.ts'.length)] = path.join(testDir, file);
  }
}

esbuild
  .build({
    entryPoints,
    outdir: 'out/test',
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    sourcesContent: false,
    external: ['vscode', 'mocha'],
    logLevel: 'info',
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
