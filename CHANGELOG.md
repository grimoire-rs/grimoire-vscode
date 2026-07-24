# Changelog

All notable changes to the Grimoire VS Code extension.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.4]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.3..v0.2.4
[0.2.3]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.2..v0.2.3
[0.2.2]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.1..v0.2.2
[0.2.1]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.2.0..v0.2.1
[0.2.0]: https://github.com/grimoire-rs/grimoire-vscode/compare/v0.1.0..v0.2.0
[0.1.0]: https://github.com/grimoire-rs/grimoire-vscode/tree/v0.1.0

