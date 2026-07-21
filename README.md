<p align="center">
  <img src="assets/logo.png" alt="Grimoire logo" width="128" height="128">
</p>

<h1 align="center">Grimoire for VS Code</h1>

A marketplace UI for [grim](https://github.com/grimoire-rs/grimoire) — the
OCI-backed package manager for AI artifacts (skills, rules, agents, MCP servers,
and bundles). Search the catalog, read the docs, and install, update, and remove
artifacts without leaving the editor — the familiar Extensions view, but for the
AI artifacts your tools rely on.

## What it does

- **Browse the catalog** — the **Browse** tab searches every configured
  registry at once. Filter by kind with the chip row (Skill / Rule / Agent /
  MCP / Bundle).
- **Stay current** — the **Updates** tab lists every installed artifact with a
  newer version available (the tab and the activity-bar icon carry the count).
  An **Update All** icon appears in the sidebar's title bar whenever updates
  are pending and updates them in one click (also always available in the
  title bar's `…` menu).
- **See what you have** — the **Installed** tab lists your installed artifacts,
  with a **Project / Global** toggle to switch which scope's list you're looking
  at. A status line pinned below the list shows when the catalog was last
  synced.
- **Read before you install** — open any artifact in an editor tab with
  **README**, **CONTENTS**, and **CHANGELOG** tabs and a metadata rail
  (installation status, package info, source and license, keywords). Single-click
  opens a reusable preview tab; double-click pins it, and links between artifacts
  navigate in place.
- **Instant details** — reopening an artifact paints immediately from an on-disk
  cache and refreshes in the background; top Browse results are prefetched so
  opens feel instant and card logos appear as they load.
- **Install, update, and uninstall per scope** — install into your **project**
  (`grimoire.toml` in the workspace) or **globally** (`~/.grimoire`), or both at
  once — a project install shadows the global one. Artifacts pulled in by a
  bundle point back to their bundle instead of offering a direct uninstall.
- **Pick a version** — install, downgrade, or pin an exact tag from the details
  header or a card's menu.
- **Recover from a blocked install** — when `grim` refuses to overwrite local
  changes, Grimoire offers an **Overwrite** confirm instead of a bare error. A
  refusal it can never safely force — a recorded path resolving outside its
  anchor root — points you at **Show Output** and the uninstall-then-reinstall
  fix instead.
- **Share a link** — copy a `vscode://` deep link to any artifact; opening it
  reveals that artifact's details.
- **Get grim automatically** — if `grim` isn't on your `PATH`, Grimoire offers to
  download the latest release from GitHub (checksum-verified).
- **Stay up to date** — once a day Grimoire checks GitHub for a newer `grim`
  release. If it manages the binary it offers a one-click update; otherwise it
  links the release page. Turn it off with `grimoire.checkForUpdates`.
- **Live refresh** — watches `grimoire.toml` / `grimoire.lock` and refreshes the
  views when things change on disk, so the UI stays in sync with the `grim` CLI
  and its terminal UI (TUI).
- **Configure grim itself** — the $(settings-gear) icon opens a **Settings**
  editor tab with Project / Global peer tabs for every `grim config` key
  (registry, clients, TUI defaults, …) and registry management, backed
  directly by `grim config`/`grim config registry` — no separate copy of the
  config to keep in sync.

Installing artifacts runs the `grim` executable, so Grimoire's install actions
require a **trusted** workspace.

## Commands

Run from the Command Palette (all under the **Grimoire** category).

| Command                                        | Does                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `Grimoire: Search Artifacts`                   | Focus the Browse tab and jump to its search box                                  |
| `Grimoire: Refresh Catalog`                    | Re-fetch the catalog and refresh every tab                                       |
| `Grimoire: Update All Artifacts`               | Update every artifact with a pending update (project + global)                   |
| `Grimoire: Initialize Project (grimoire.toml)` | Create a `grimoire.toml` in the workspace so it can hold project-scoped installs |
| `Grimoire: Install grim CLI`                   | Download the latest `grim` release from GitHub                                   |
| `Grimoire: Open Settings`                      | Open the Settings editor tab (`grim config` UI)                                  |
| `Grimoire: Show Output`                        | Open the Grimoire output channel                                                 |
| `Grimoire: Report Bug`                         | Open a prefilled GitHub bug report                                               |
| `Grimoire: Request Feature`                    | Open a prefilled GitHub feature request                                          |

The `grimoire.openDetails` command is intentionally omitted — it's invoked via
the `vscode://` deep link, not run from the Command Palette.

## Settings

| Setting                    | Default   | Does                                                                                                                                                                                   |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grimoire.path.executable` | `grim`    | Path to (or name of) the `grim` executable, resolved against `PATH` when not absolute                                                                                                  |
| `grimoire.defaultScope`    | `project` | Install scope (`project` or `global`) for the **Pin to a tag** flow. The main **Install** action ignores this and always uses project when a configured workspace is open, else global |
| `grimoire.watchForChanges` | `true`    | Refresh views when `grimoire.toml` / `grimoire.lock` change                                                                                                                            |
| `grimoire.prefetchDetails` | `true`    | Prefetch top Browse results so details open instantly and card logos appear                                                                                                            |
| `grimoire.checkForUpdates` | `true`    | Once a day, check GitHub for a newer `grim` release and offer to update (or link the release page)                                                                                     |
| `grimoire.extraEnv`        | `{}`      | Extra environment variables for the `grim` child process (e.g. `GRIM_HOME`, registry credentials)                                                                                      |

## Requirements

Grimoire drives the [grim](https://github.com/grimoire-rs/grimoire) CLI — it
doesn't reimplement it. If `grim` isn't found on your `PATH`, Grimoire offers to
install the latest release for you; you can also point `grimoire.path.executable`
at an existing build.

Grimoire requires `grim` 0.11.0 or newer — the release that ships the
`forceable`/`anchor-escape` error contract behind the overwrite-confirm and
anchor-escape recovery dialogs. An older `grim` fails every call with a
version-floor error rather than running in a degraded mode; point
`grimoire.path.executable` at a current build if you're behind.

## Contributing

Bug reports, feature requests, and PRs welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, build/test workflow,
and conventions.

## License

[Apache-2.0](LICENSE)
