# Contributing to Grimoire for VS Code

Thanks for helping improve the Grimoire VS Code extension. This guide covers
the development setup, the build/test workflow, and the conventions PRs are
expected to follow.

## Prerequisites

- **Node.js 20+** (see `engines.node` in `package.json`).
- The **`grim` CLI** on `PATH` for manual testing (or point
  `grimoire.path.executable` at it). Integration tests stub the binary with a
  POSIX shell script, so `npm test` does not need a real `grim` — see
  [Testing](#testing).

## Setup

```sh
npm ci
```

## Develop

Press <kbd>F5</kbd> in VS Code (`Run Extension`) to launch the **Extension
Development Host** with the extension loaded. Run `npm run watch` alongside so
the esbuild bundle rebuilds on save; reload the dev host window to pick it up.

| Script | Purpose |
| --- | --- |
| `npm run build` | Bundle via `node esbuild.js` |
| `npm run build:prod` | Production bundle (minified; runs on `vscode:prepublish`) |
| `npm run watch` | Rebuild on change (use during F5 debugging) |
| `npm run check-types` | `tsc --noEmit` (esbuild does not type-check) |
| `npm run lint` | ESLint over `src` |
| `npm run format` | Format everything with `prettier --write .` |
| `npm run format:check` | Verify formatting with `prettier --check .` (no writes) |
| `npm run check` | Full gate: lint + type-check + build |
| `npm test` | `@vscode/test-cli` suite (unit + integration) with coverage |
| `npm run package` | Build a `.vsix` via `vsce package --no-dependencies` |

Prettier is **not** run by `npm run check` or CI — run `npm run format` yourself
before committing. ESLint pulls in `eslint-config-prettier`, which only turns off
the ESLint rules that would fight Prettier; it doesn't run Prettier for you.

## Verify before you commit

Run the full gate and the tests:

```sh
npm run check
npm test
```

On **headless Linux**, the tests need a display server:

```sh
xvfb-run -a npm test
```

`npm test` runs `pretest` first (compile tests, build, lint), then
`vscode-test --coverage` with text and lcov reporters.

## Project layout

- `src/extension.ts` — entry point (`activate`/`deactivate`); thin wiring only.
- `src/grim.ts` — the only place that spawns the `grim` binary. Pure argv
  builders plus envelope parsing (`execFile`, no shell, always `--format
  json`); grim's JSON interface is frozen/additive, so nullable fields are
  treated as honestly nullable, never assumed present.
- `src/scopes.ts` — scope discovery via `grim context` (project = the
  workspace folder, global = `--global`) and declared-reference parsing from
  `grimoire.toml`.
- `src/config.ts`, `src/watchers.ts`, `src/catalog.ts`, `src/prefetch.ts`,
  `src/detailsCache.ts` — configuration reading, `grimoire.toml`/`.lock` file
  watching, catalog search, prefetching top browse results, and the on-disk
  details cache (stale-while-revalidate).
- `src/installer.ts` — the `grim` auto-installer: reads a GitHub release's
  `dist-manifest.json`, downloads the matching archive, verifies its sha256,
  and extracts with the system `tar`. Never hardcode an archive extension —
  the manifest is the source of truth.
- `src/views/` — the extension-host side of the webviews: the three sidebar
  views (Browse/Updates/Installed, all backed by one `SidebarProvider` in
  `sidebar.ts`) and the details webview panel (`details.ts`), plus the shared
  HTML shell (`html.ts`) and supporting UI (`pickVersion.ts`, `staleLock.ts`).
- `src/webview/` — the message protocol (`protocol.ts`) and pure model/render
  modules (`model.ts`, `render.ts`, `markdown.ts`) with no `vscode` or DOM
  imports, so they stay unit-testable outside the Extension Development Host.
  `src/webview/sidebar/main.ts` and `src/webview/details/main.ts` are thin
  event-wiring entries over those pure renderers.
- `src/test/` — the test suite (see [Testing](#testing)).

## Rendering rules

Webview UI renders through **lit-html templates only** — never build webview
DOM from concatenated HTML strings. Lists use keyed `repeat()`; event wiring
is delegated via `data-action` attributes on the root element rather than
per-node listeners.

The details panel inlines a server-rendered skeleton into `#root` before the
webview script boots, so the first paint shows real structure instead of an
empty shell. That skeleton is produced by rendering the **same** lit-html
templates used in the webview to a string with `@lit-labs/ssr`
(`collectResultSync(render(...))` in `src/views/details.ts`) — there is no
second, hand-written HTML copy to keep in sync.

Webviews run under a strict CSP (nonce-only scripts) and render Markdown with
`markdown-it` (`html:false`). lit-html auto-escapes template bindings;
`unsafeHTML` is reserved for markdown-it's output and the details JSON
highlighter's self-escaped spans — nothing else. Any string-rendered path
(the host-side HTML shell) must escape every dynamic value through `esc()`.
Add an escaping test alongside any new render path that touches raw strings.

## Testing

Tests live in `src/test/` and run inside a real VS Code via
`@vscode/test-cli`/`@vscode/test-electron`; pure logic (model builders,
render output, protocol shapes) is exercised the same way but needs no
`vscode` API.

Integration tests that would otherwise shell out to `grim` stub the binary
with a generated POSIX shell script (`writeStub` in
`src/test/extension.test.ts`) that logs its argv and answers canned JSON
fixtures — this keeps the suite fast and independent of a real `grim`
install, and is skipped on Windows (`process.platform === 'win32'`), where
integration coverage relies on the pure unit tests instead.

A small live contract suite (`src/test/grimLive.test.ts`) additionally runs
against a real `grim` from `PATH` when one is installed (self-skips
otherwise). Environment knobs for debugging sessions:

- `GRIM_LIVE_BIN=/path/to/grim` — pin a specific build (e.g. a local
  `../grimoire/target/release/grim`) instead of the `PATH` one.
- `GRIM_LIVE_NETWORK=1` — also run the checks that resolve through a real
  registry (off by default so `npm test` stays offline).

Markup regression baselines live in `src/test/fixtures/goldens/` and are
checked by `src/test/parity.test.ts` against `src/webview/render.ts`'s
current output (normalized via `src/test/normalizeHtml.ts` to absorb only
incidental lit-html SSR marker noise). A failing golden names a real markup
delta — do not "fix" it by regenerating blindly. Only regenerate when the UI
change is intentional:

```sh
UPDATE_GOLDENS=1 npm test
```

Review the resulting diff under `src/test/fixtures/goldens/` like code before
committing it.

## Commits

This repo uses [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `refactor:`, `ci:`, `chore:`, `docs:`, `test:`, `perf:`,
`build:`, `style:`.

## Pull requests

1. Never commit directly to `main`; branch off it (`feat/…`, `fix/…`, …).
2. Keep changes focused; add tests for user-facing behavior and a regression
   test for each bug fix.
3. Ensure `npm run check` and `npm test` pass locally before opening the PR.
4. Open the PR against `main`.

## Filing issues

Bug reports and feature requests are welcome on the
[issue tracker](https://github.com/grimoire-rs/grimoire-vscode/issues). For
problems with the `grim` CLI itself (install, registries, `grimoire.toml`
semantics), file against the
[grimoire CLI repo](https://github.com/grimoire-rs/grimoire) instead.

<!-- TODO(release): link a screenshot/GIF walkthrough here once the views are stable enough to capture. -->

## License

By contributing, you agree your contributions are licensed under the
project's [Apache-2.0 license](LICENSE).
