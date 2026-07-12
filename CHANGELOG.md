# Changelog

All notable changes to the Grimoire VS Code extension.

## [0.1.0]

First release.

### Requires

- grim newer than the 0.8.4 release — the first grim with the v2
  description-companion interface (`grim describe` reporting `has_description`,
  and `grim fetch --description` / `--digest-only`).
  <!-- TODO(release): pin the exact minimum grim version once that release is cut. -->
  The extension can auto-install grim from GitHub. Binaries predating the v2
  surface show in-tree content only and surface their real errors (no compat shims).

### Added

- **Browse & Installed marketplace UI** — search the artifact catalog across all
  configured registries; filter by kind (skill / rule / agent / mcp / bundle) with
  badge chips, by registry, or by installed state. The Installed view groups your
  artifacts by scope with pending updates, _Update All_, and deprecation flags.
- **Details editor tab** — README, CONTENTS (bundle members / source / manifest),
  and CHANGELOG tabs, plus a right rail of package metadata (registry, repository,
  tags, published date, revision), resources, and keywords. Single-click opens a
  reusable preview tab; double-click pins it, and links between artifacts navigate
  in place.
- **Install / update / uninstall per scope** — project (`grimoire.toml`) and global
  (`~/.grimoire`) at the same time; the project copy shadows the global one.
  Members installed by a bundle are flagged and removed via their bundle. A version
  picker installs, downgrades, or pins a specific tag.
- **Description-companion content, cached** — README, CHANGELOG, and logo published
  alongside an artifact are fetched inline; a reopened details panel paints instantly
  from an on-disk cache (stale-while-revalidate) with a top-right refresh indicator,
  and top browse results are prefetched so opens paint immediately and card logos
  pop in.
- **grim auto-install** — offers to download a checksum-verified grim release from
  GitHub when none is on your PATH.
- **Live refresh** — watches project + global `grimoire.toml` / `grimoire.lock` and
  refreshes the views when grim state changes (CLI or TUI operations).
- **Shareable `vscode://` deep links** to any artifact's details panel.
