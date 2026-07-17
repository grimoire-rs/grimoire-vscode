// Build script: one Node bundle for the extension host, one browser bundle
// per webview. VS Code's extension host loads CommonJS (`vscode` external);
// webviews are plain browser scripts (IIFE) with CSS emitted alongside.
// Type checking is done separately via `tsc --noEmit`.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Surfaces esbuild errors in a format the VS Code problem matcher understands.
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

function copyCodicons() {
  const src = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
  const dest = path.join(__dirname, 'dist', 'webview');
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
}

async function main() {
  const common = {
    bundle: true,
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
  };

  const hostCtx = await esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
  });

  const webviewCtx = await esbuild.context({
    ...common,
    entryPoints: {
      sidebar: 'src/webview/sidebar/main.ts',
      details: 'src/webview/details/main.ts',
      settings: 'src/webview/settings/main.ts',
    },
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outdir: 'dist/webview',
  });

  copyCodicons();

  if (watch) {
    await Promise.all([hostCtx.watch(), webviewCtx.watch()]);
  } else {
    await Promise.all([hostCtx.rebuild(), webviewCtx.rebuild()]);
    await Promise.all([hostCtx.dispose(), webviewCtx.dispose()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
