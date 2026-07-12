# AGENTS.md

Instructions for AI coding agents. Claude Code: read CLAUDE.md (authoritative).

- Build runner is npm: `npm run check` (lint + types + build) must pass after
  every change; `npm test` runs the full suite with coverage.
- All grim invocations go through `src/grim.ts` (execFile, no shell,
  `--format json`). Do not spawn grim anywhere else.
- `src/webview/model.ts` and `src/webview/render.ts` must stay free of vscode
  and DOM imports (pure, unit-tested). Escape everything with `esc()`.
- Conventional Commits. Never commit to `main`, never push, never touch
  publish tokens. Use non-interactive shell flags.
