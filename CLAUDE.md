# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

VS Code extension `grimoire` (publisher `grimoire-rs`): a marketplace UI for the
`grim` CLI (OCI-backed package manager for AI artifacts — skills, rules, agents,
MCP servers, bundles). Sibling repo: `../grimoire` (the Rust CLI).

## Build & verify

npm is the build runner (no bun, no task runner).

- `npm run check` — lint + type-check + build. Run after every change.
- `npm test` — full suite under @vscode/test-cli with coverage (c8). Linux headless: `xvfb-run -a npm test`.
- `npm run package` — build the .vsix (vsce, `--no-dependencies`).

## Architecture

- `src/grim.ts` — the only place that spawns grim (`execFile`, no shell, always
  `--format json`). Pure argv builders + envelope parsing (`error` key first,
  then exit codes). grim's JSON interface is frozen/additive — never assume a
  field exists; nullable means null.
- `src/scopes.ts` — scope discovery via `grim context` (project = workspace cwd,
  global = `--global`). Declared refs parsed from grimoire.toml.
- `src/views/` — extension-host side of the webviews. `src/webview/` — shared
  protocol + PURE model modules (no vscode, no DOM imports) so they stay
  unit-testable; the browser entries under `src/webview/{sidebar,details}/` are
  thin event wiring. Keep logic in model/render, not in main.ts files.
- Webview UI renders through lit-html templates — ALWAYS. Never build webview
  DOM from concatenated HTML strings. Lists use keyed `repeat()`; event wiring
  stays delegated via `data-action` attributes on root. The host-side inline
  first-paint skeleton (baked into `webview.html` before the webview process
  boots) is produced by rendering the SAME templates to a string with
  `@lit-labs/ssr` — never a second hand-written HTML copy.
- `src/installer.ts` — grim auto-install from GitHub releases via
  dist-manifest.json (never hardcode archive extensions; tar.xz today, tar.gz
  planned). Extraction via system `tar -xf`.
- Webviews: strict CSP (nonce scripts), markdown-it with `html:false`. lit-html
  auto-escapes bindings; `unsafeHTML` is reserved for markdown-it output and
  highlightJson's self-generated esc()-escaped spans — nothing else, ever.
  String-rendered paths (host HTML shell) escape every dynamic value through
  `esc()`. Add an escaping test for any new render path.

## Conventions

- Conventional Commits. Never commit to `main`; work on a branch. Never push
  without being asked.
- Tests live in `src/test/`; integration tests stub grim with a POSIX shell
  script (skipped on Windows) — see `writeStub` in `extension.test.ts`.
- Match the design mockups (claude.ai/design "Grimoire Skill Marketplace"):
  theme tokens only (`--vscode-*`), codicons per kind (skill=sparkle, rule=law,
  agent=hubot, mcp=plug, bundle=package), null metadata renders as
  "Not provided", empty panels are omitted.
