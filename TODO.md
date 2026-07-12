# TODO

- [x] Vertical bar in search results (2026-07-12) — the bar was the initialize-project
  banner's blockquote-style `border-left: 3px` accent (textBlockQuote tokens), not a
  stray component; the banner is now a proper notification box on the VS Code
  notification theme tokens (notifications background/border + info-icon codicon),
  no accent bar.
- [x] Init notification top right below the header (2026-07-12) — in the merged
  view's Browse tab the notification floats at the top right just below the
  tabs/search/filters header chrome, overlaid on the scrolling results via a
  zero-height sticky anchor (editor-notification idiom); the Installed tab keeps it
  inline above its list. Supporting fix: browse search falls back to global scope
  when the open folder has no grimoire.toml (project-scope search has no registries
  there and returned []), so the catalog stays browsable behind the notification.
- [x] Search errored beyond one word (2026-07-12) — two argv bugs. grim's
  `search [QUERY]` is ONE positional that grim whitespace-splits itself, but
  searchArgs pre-split the words into separate argv entries — clap rejected the
  second ("unexpected argument"); the query now travels as a single string. And the
  global-scope `--global` was appended blindly at the end, where it landed AFTER the
  `--` positional separator (same clap error, global scope only) — it now leads
  before the subcommand as the canonical top-level flag (withGlobalFlag). Verified
  against grim 0.9.1: project + global multi-word and flag-like queries all parse.
