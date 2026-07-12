# TODO

- [x] Vertical bar in search results (2026-07-12) — the ugly bar was the results
  list's vertical scrollbar: `#sb-results` scrolls internally and got the webview
  default always-visible scrollbar instead of the workbench look. It now uses the
  `--vscode-scrollbarSlider-*` tokens — trackless, square thumb, visible only while
  the pointer is over the list (CSS's closest stand-in for show-on-scroll).
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
