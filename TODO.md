# TODO

- [x] Vertical bar in search results (2026-07-12) — the ugly bar was the results
  list's vertical scrollbar, and "wrong component" was exactly right: the results
  now scroll inside `vscode-scrollable` (@vscode-elements), the workbench-style
  overlay scrollbar the native marketplace list has — hover/scroll-visible thumb on
  the `--vscode-scrollbarSlider-*` tokens, transparent track, top scroll-shadow.
  Plain CSS could not fix it: the webview default stylesheet sets
  `html { scrollbar-color: <slider> <editor-background> }`, which paints the track
  with the wrong surface color in the sidebar AND (scrollbar-color being set and
  inherited) makes Chromium ignore `::-webkit-scrollbar` rules outright — a first
  CSS-only attempt visibly changed nothing because of this.
- [x] Init notification placement (2026-07-12) — the initialize-project box moved
  out of the results into its own `#sb-notice` region at the very top of the view,
  just above the BROWSE/UPDATES/INSTALLED tab row, in normal flow (a first cut
  floated it over the results — reverted on feedback). It is also restyled as a
  notification (VS Code notification tokens + info icon) instead of the old
  blockquote-style box, and the Installed tab's inline copy is gone — one notice,
  one place, all tabs. Supporting fix: browse search falls back to global scope
  when the open folder has no grimoire.toml (project-scope search has no registries
  there and returned []), so the catalog stays browsable while the notice shows.
- [x] Search errored beyond one word (2026-07-12) — two argv bugs. grim's
  `search [QUERY]` is ONE positional that grim whitespace-splits itself, but
  searchArgs pre-split the words into separate argv entries — clap rejected the
  second ("unexpected argument"); the query now travels as a single string. And the
  global-scope `--global` was appended blindly at the end, where it landed AFTER the
  `--` positional separator (same clap error, global scope only) — it now leads
  before the subcommand as the canonical top-level flag (withGlobalFlag). Verified
  against grim 0.9.1 and confirmed working by the user.
