# Changelog

All notable changes to the Grimoire VS Code extension.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] - 2026-08-31

### Added

- Order browse and installed by name, date or rating *(sidebar)*
- Offer a way in when a vote finds no credential *(rate)*
- Honour the scope an index page picked *(deep-link)*

### Changed

- Paint the cached artifact in the first HTML parse *(details)*
- Fold the incomplete-catalog warning into the footer line *(sidebar)*

### Fixed

- Stop reporting an unreadable scope as an empty catalog *(sidebar)*
- Stop the incomplete-results warning blinking on every refresh *(sidebar)*

## [0.3.3] - 2026-08-30

### Added

- Paint the last known results before grim answers *(sidebar)*

## [0.3.2] - 2026-08-28

### Added

- Add a /vote deep link for index sites *(vote)*

## [0.3.1] - 2026-08-28

### Added

- Resolve a vote credential and pipe it to grim on stdin *(rate)*
- Show a three-state rating and vote from the details panel *(rate)*
- Read the curated annotations and support channels off describe *(grim)*
- Show curated annotations and a support channel panel *(details)*

### Documentation

- Name the annotation showcase in the manual-rig guide *(testing)*

### Fixed

- Drop details entries written before the curated annotations *(cache)*

### Merge

- DF-H — pin the vote command's refusal branches (F-8); DF-G unreproduced (F-7)

## [0.3.0] - 2026-08-13

### Added

- Edit registries and browse filters (grim 0.13.0+) *(settings)*
- Compact rows, a registry tree, and grouping *(sidebar)*
- Adopt grim's per-registry insecure field *(settings)*
- Show a live version on index-backed browse rows *(sidebar)*
- Show the installed version on the chip, beside the name *(sidebar)*
- Check for artifact updates off every refresh, debounced
- Sweep the rows in view, not a fixed top-24 *(sidebar)*
- Surface materialization drift and offer to complete the install
- Offer a way forward when Update All hits a modified artifact *(update)*
- Read a refused update off the report rows *(grim)*
- Offer Overwrite when grim refuses a locally-modified update *(views)*

### Changed

- Build the registry form's booleans from vscode-elements *(settings)*
- Make every boolean in the panel one switch component *(settings)*
- Drop the redundant nouns from command titles *(commands)*
- Drop the Updates view, badge the marketplace view *(sidebar)*
- Mark the default registry with a star, not the word *(sidebar)*
- Use the codicons made for agents and MCP servers *(webview)*
- One artifact-icon fallback for every surface *(webview)*
- One record for every action that runs grim *(webview)*
- Treat a separator-less argv as having no positional *(grim)*

### Documentation

- Name the grim version browse filters need
- Point non-rig workspaces at grimoire.extraEnv for plain HTTP
- Describe the viewport sweep and the incomplete-install flow
- State what the mutating-actions drift test actually covers *(webview)*
- Correct what outputs_pending and update_available mean *(grim)*

### Fixed

- Render one card per repo when two sources list it *(sidebar)*
- Dismiss the scope menu when the panel loses focus *(details)*
- Stop reading a stale lock as an available update *(sidebar)*
- Keep cached content when a probe partly fails *(details)*
- Show a deliberate placeholder for an image that cannot load *(webview)*
- Report the viewport when scrolling settles, not during it *(sidebar)*
- Paint what the cache holds, not what the probe returned *(details)*
- Let a refused Complete Install notice go without blocking *(views)*
- Stop a losing probe from overwriting cached content *(details)*
- Age the post-action cache entry out instead of deleting it *(details)*
- Log a refused-install notice that fails instead of dropping it *(views)*

## [0.2.7] - 2026-07-31

### Fixed

- Mark deprecated cards by struck name alone *(sidebar)*
- Lock every action control while a grim run is in flight *(views)*

## [0.2.6] - 2026-07-31

### Added

- Add an add-registry deep link for index websites
- Add-registry deep link for index websites

### Fixed

- Keep the Updates list in sync with its count *(sidebar)*
- Stop registry-controlled values reaching grim as flags
- Key installs by artifact identity, not by name alone

## [0.2.5] - 2026-07-27

### Added

- Remember grim --check verdicts across plain refreshes *(status)*
- Move the update badge to a view that exists before first open *(sidebar)*
- Separate artifact update checks from the grim release check *(config)*

### Fixed

- Count updates by grim's verdict, not by row state *(sidebar)*
- Clear the update count when grim is missing *(sidebar)*
- Spawn the resolved grim by absolute path, never a bare name *(grim)*
- Correct the update count's verdict memory and publishers *(sidebar)*

## [0.2.4] - 2026-07-24

### Added

- Add a grim info action to the view menu *(sidebar)*

### Changed

- Remove the unused showDeprecated card filter *(webview)*

### Documentation

- Clarify that defaultScope only affects install actions *(config)*
- Document Show grim Info, the degraded mode, and the Pin Version label *(readme)*

### Fixed

- Keep config_exists when the version floor trips *(scopes)*
- Keep browsing when install state is unknown *(sidebar)*
- Flag when the edited scope is not the one browse searches *(settings)*
- Re-arm the global watchers from the refresh snapshot *(extension)*
- Drop superseded search responses *(catalog)*
- Coalesce overlapping refreshAll runs *(extension)*
- Model unknown install state as a first-class scope state *(sidebar)*
- Isolate refresh rounds and harden watcher self-heal *(extension)*
- Name the remedy in the scope-mismatch notice *(settings)*
- Keep browse-card logos in sync with the cache *(details)*

## [0.2.3] - 2026-07-22

### Added

- Confirm before forcing a recoverable grim refusal *(views)*

### Fixed

- Honor path.executable in remote windows *(config)*
- Tolerate a status/update report missing its client arrays *(extension)*

## [0.2.2] - 2026-07-21

### Fixed

- Gate on a minimum grim version and keep views consistent

## [0.2.1] - 2026-07-19

### Fixed

- Surface failed status as error instead of empty installs *(status)*
- PATH grim wins over extension-managed copy *(scopes)*

## [0.2.0] - 2026-07-19

### Added

- Init banner becomes a notification, floating top-right in browse *(sidebar)*
- Daily grim update check with managed-binary update offer *(installer)*
- Render header description as inline markdown *(details)*
- Add config/registry argv builders and wire types *(grim)*
- Add Settings panel, retire grimoire.showDeprecated *(views)* **BREAKING**
- **Migration:** the grimoire.showDeprecated setting is removed. Set options.show_deprecated via the new Settings panel (or `grim config set options.show_deprecated <true|false>`) instead.
- Parse retryable on error envelope; add isRetryable *(grim)*
- Adopt status --check with honest update_available *(status)*
- Replaced-by link and client-drift badge on cards *(sidebar)*
- Typed update report with reap surfacing *(update)*
- Constraints-driven chip validation *(settings)*
- Registry field labels from grim metadata *(settings)*
- One-click switch to replacement artifact *(views)*
- Adopt config set --dry-run marker *(settings)*
- Slim sidebar toolbar to overflow menus *(views)*

### Changed

- Drop builder-level --global; run() owns scope flags *(grim)*

### Documentation

- Record resolutions for the three open items *(todo)*
- Correct item-1 resolution (scrollbar, not banner border) *(todo)*
- Correct exit-75 comment framing; note replacedBy menu key *(grim)*

### Fixed

- Pass the query as one positional and lead with --global *(search)*
- Browse searches global scope when the project is unconfigured *(catalog)*
- Notice above the tab bar + workbench-style results scrollbar *(sidebar)*
- Results scroll inside vscode-scrollable (workbench scrollbar) *(sidebar)*
- Position menus fixed on root so the scroll viewport can't clip them *(sidebar)*
- Close menus on every results scroll via the shadow scroller *(sidebar)*
- Failed project probe must not read as unconfigured *(scopes)*
- Force --refresh on explicit refresh; footer shows reliably *(sidebar)*
- Protect config/registry argv from leading-hyphen values *(grim)*
- Stop treating grim's NotDiscovered as a probe failure *(scopes)*
- Pin loading status to footer, match init-offer design *(sidebar)*

## [0.1.0] - 2026-07-16

### Fixed

- Rename extension to grimoire-vscode
- Display name 'Grimoire Marketplace'

[0.3.4]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.3.3..v0.3.4
[0.3.3]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.3.2..v0.3.3
[0.3.2]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.3.1..v0.3.2
[0.3.1]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.3.0..v0.3.1
[0.3.0]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.7..v0.3.0
[0.2.7]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.6..v0.2.7
[0.2.6]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.5..v0.2.6
[0.2.5]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.4..v0.2.5
[0.2.4]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.3..v0.2.4
[0.2.3]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.2..v0.2.3
[0.2.2]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.1..v0.2.2
[0.2.1]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.0..v0.2.1
[0.2.0]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.1.0..v0.2.0
[0.1.0]: https://github.com/grimoire-rs/grimoire-vscode/tree/v0.1.0

