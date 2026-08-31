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
- **Stay current** — once a day Grimoire asks your registries which installed
  artifacts have newer versions and carries the count on the activity-bar icon
  and on the **Updates** tab. The tab lists them; an **Update All** icon appears
  in the sidebar's title bar
  whenever updates are pending and updates them in one click (also always
  available in the title bar's `…` menu). Check on demand with
  **Grimoire: Check for Updates**, or turn the automatic ones off with
  the `grimoire.checkArtifactUpdates` **setting** — the verdicts already gathered
  keep counting either way. The update check asks the registries your
  `grimoire.toml` names, so it is skipped in a **restricted** (untrusted)
  workspace and starts as soon as you trust the folder. The command is
  deliberately not gated that way: running it yourself is the go-ahead.
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
  cache and refreshes in the background; the Browse rows you can see are
  prefetched as you scroll, so opens feel instant and card logos appear as they
  load.
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
  fix instead. A whole-scope run that stops for the same reason (**Update All**,
  or **Complete Install**) never offers a one-click overwrite, because forcing it
  would discard your edits to every other artifact in the scope: it names the
  modified artifact and offers to open it, so you can decide one at a time.
- **Finish an incomplete install** — when an artifact is installed and intact but
  `grim` would still write something for it (a client that gained support since
  the last install, or a render-layout move), the row shows an **Install
  incomplete** hint and a **Complete Install** action that re-materializes that
  scope's lock.
- **Share a link** — copy a `vscode://` deep link to any artifact; opening it
  reveals that artifact's details.
- **Upvote from the web** — an index site can link
  `vscode://grimoire-rs.grimoire-vscode/vote?repo=<url-encoded repo>`. It opens
  the artifact and asks to upvote it; the vote is a public post on the index's
  forge thread under your own account, so it only happens after you confirm the
  dialog naming the artifact. Needs `grim` 0.14.0 or newer. A link can only
  cast a vote — retracting one stays a button in the details panel.
- **Add an index from the web** — an index site can link
  `vscode://grimoire-rs.grimoire-vscode/add-registry?index=<https url>&alias=<name>`,
  optionally with `&include=`/`&exclude=` browse-filter globs (repeat the key per
  pattern) and `&scope=project|global` for the scope its own Scope picker was on.
  Without `scope` it writes the project `grimoire.toml` when a folder is open and
  the global one otherwise; with no folder open it is always global. The link
  authorizes nothing on its own — a modal naming the exact index URL, alias,
  patterns, and which `grimoire.toml` is written is what does.
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

| Command                        | Does                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `Grimoire: Search`             | Focus the Browse tab and jump to its search box                                  |
| `Grimoire: Refresh Catalog`    | Re-fetch the catalog and refresh every tab                                       |
| `Grimoire: Check for Updates`  | Ask your registries which installed artifacts have newer versions                |
| `Grimoire: Update All`         | Update every artifact with a pending update (project + global)                   |
| `Grimoire: Initialize Project` | Create a `grimoire.toml` in the workspace so it can hold project-scoped installs |
| `Grimoire: Install grim`       | Download the latest `grim` release from GitHub                                   |
| `Grimoire: Open Settings`      | Open the Settings editor tab (`grim config` UI)                                  |
| `Grimoire: Show Output`        | Open the Grimoire output channel                                                 |
| `Grimoire: Show Info`          | Which `grim` would be spawned, how it was resolved, and its version              |
| `Grimoire: Store Rating Token…`| Store a personal access token for a rating host (see **Voting**)                 |
| `Grimoire: Clear Rating Token…`| Remove the stored token for a rating host                                        |
| `Grimoire: Report Bug`         | Open a prefilled GitHub bug report                                               |
| `Grimoire: Request Feature`    | Open a prefilled GitHub feature request                                          |

`grimoire.openDetails` is intentionally omitted from the palette — it is
invoked via the `vscode://` deep link.

## Voting

An upvote is a public post on the index's forge thread, under **your** account —
so it needs a credential for the forge host, and Grimoire will never guess one.
`grim rate --dry-run` names the host first; the credential is then chosen from
that host alone, and if none can be found for it, nothing is sent.

Where the credential comes from, in order:

1. **The forge's own VS Code sign-in.** `github.com` uses the built-in GitHub
   account. A GitHub Enterprise host uses the built-in `github-enterprise`
   provider — and only when `github-enterprise.uri` names that exact host. A
   **GitLab** host needs the
   [GitLab Workflow](https://marketplace.visualstudio.com/items?itemName=GitLab.gitlab-workflow)
   extension, which is what registers a `gitlab` account in VS Code; without it
   installed there is no GitLab sign-in to use. Its instance setting must also
   name the host being rated: GitLab Workflow registers one identity for
   gitlab.com and self-managed alike, so a gitlab.com token is never sent to a
   corporate instance just because both are "GitLab".

2. **A token you store.** `Grimoire: Store Rating Token…` keeps a personal
   access token in VS Code's secret storage, keyed by host. This is the path for
   a self-managed instance GitLab Workflow is not pointed at, and it works with
   no extra extension at all. On GitLab the token needs `api` scope (it posts to
   a discussion); on GitHub, `public_repo`. `Grimoire: Clear Rating Token…`
   takes it back out.

A vote that finds neither says so and offers whichever of the two applies. See
grim's [self-hosted GitLab guide](https://grimoire.rs/self-hosted-gitlab.html)
for standing up the index side on a corporate instance.

## Settings

| Setting                         | Default   | Does                                                                                                                                                                                  |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grimoire.path.executable`      | `grim`    | Path to (or name of) the `grim` executable, resolved against `PATH` when not absolute                                                                                                 |
| `grimoire.defaultScope`         | `project` | Install scope (`project` or `global`) for the **Pin Version** flow. The main **Install** action ignores this and always uses project when a configured workspace is open, else global |
| `grimoire.watchForChanges`      | `true`    | Refresh views when `grimoire.toml` / `grimoire.lock` change                                                                                                                           |
| `grimoire.prefetchDetails`      | `true`    | Prefetch the Browse rows in view as you scroll, so details open instantly and card logos appear                                                                                       |
| `grimoire.checkForUpdates`      | `true`    | Once a day, check GitHub for a newer `grim` release and offer to update (or link the release page)                                                                                    |
| `grimoire.checkArtifactUpdates` | `true`    | After a refresh settles, ask your registries which installed artifacts have newer versions (`grim status --check`) — what the update count on the Grimoire icon is based on. Debounced, so a burst of changes costs one check. Off stops the automatic rounds only; remembered verdicts keep counting |
| `grimoire.extraEnv`             | `{}`      | Extra environment variables for the `grim` child process (e.g. `GRIM_HOME`, registry credentials)                                                                                     |

## Requirements

Grimoire drives the [grim](https://github.com/grimoire-rs/grimoire) CLI — it
doesn't reimplement it. If `grim` isn't found on your `PATH`, Grimoire offers to
install the latest release for you; you can also point `grimoire.path.executable`
at an existing build.

Grimoire requires `grim` 0.11.0 or newer — the release that ships the
`forceable`/`anchor-escape` error contract behind the overwrite-confirm and
anchor-escape recovery dialogs.

An older `grim` does not blank the view: browsing keeps working off the catalog,
behind a banner naming the reason. What it cannot do is report install state, so
every install and update affordance is suppressed rather than claiming "Install"
on an artifact that may already be installed. Point `grimoire.path.executable`
at a current build, or run **Grimoire: Show Info** to see which binary is
actually being spawned.

Editing a registry in place needs `grim` 0.13.0 or newer — the release that
ships the `config registry set` verb, the `--include`/`--exclude` browse
filters on `config registry add`, and the per-registry `--insecure` plain-HTTP
opt-in.

Below that version the feature is absent rather than reduced: registry rows
carry no edit button, the add-registry form shows neither pattern fields nor
the plain-HTTP checkbox, and a share link that carries filters is refused
outright instead of adding the registry without the filters you approved.
Adding, removing, and switching the default registry are unaffected.

A registry declared with `insecure = true` is contacted over plain HTTP — for a
local or in-cluster registry without TLS. The panel marks such a row, because
`grimoire.toml` is normally committed and the downgrade applies to everyone who
clones the project. `GRIM_INSECURE_REGISTRIES` (via `grimoire.extraEnv`) still
covers hosts no entry declares; the two add up.

## Contributing

Bug reports, feature requests, and PRs welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, build/test workflow,
and conventions.

## License

[Apache-2.0](LICENSE)
