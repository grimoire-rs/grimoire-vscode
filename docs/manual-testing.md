# Manual testing against real registries

The extension has no fixture registry of its own. It borrows grim's manual rig
(`../grimoire/test/manual/`): two `registry:2` containers on `localhost:5050`
and `localhost:5051`, a committed sample catalog, and ready-made consumer
projects. Everything below is real — real OCI pushes, real installs, real
`grim status` output.

Prerequisites: Docker (or Podman with the compose shim), a Rust toolchain, and
the sibling `../grimoire` checkout.

## 1. Bootstrap the rig (once)

```sh
cd ../grimoire
test/manual/scripts/bootstrap.sh          # builds grim, starts both registries, publishes the catalog
source test/manual/scripts/env.sh         # GRIM_HOME + insecure-registry env for the shell

cd test/manual/project
grim lock && grim install                 # project-scope installs
grim --global add localhost:5050/grimoire/skills/hello-world:1   # one global install, so Installed has both scopes

cd ..
scripts/release-update.sh                 # publishes code-reviewer 1.3.0 -> the "outdated" demo
```

Re-running `bootstrap.sh` is idempotent. `scripts/teardown.sh --registry` wipes
the rig and stops both containers.

## 2. Launch the extension

`F5` in this repo and pick one of:

| Launch config | Workspace | What it exercises |
|---|---|---|
| **Run Extension (manual rig — project)** | `test/manual/project` | The full catalog: version matrix, deprecated `old-reviewer`, the folded `playbooks/ci/release` chain, outdated rows after `release-update.sh` |
| **Run Extension (manual rig — multi-registry)** | `test/manual/project-multi` | Two registry roots in the tree, registry grouping, the private-registry lock |

Both configs put the rig's `grim` first on `PATH` and point `GRIM_HOME` at
`test/manual/.grim-home`, so nothing touches your real `~/.grimoire`. If your
grim checkout is not at `../grimoire`, edit the paths in `.vscode/launch.json`.

## 3. What to check

The view controls live in the **view's title bar** (the icon row beside
GRIMOIRE), not inside the webview — the same place the Explorer keeps its
collapse-all. Each toggle is a pair of commands under opposite `when` clauses,
so the icon always names the state the click switches TO, and all of them are
reachable from the command palette as `Grimoire: …`.

**Density** — the `list-flat` / `list-selection` icon swaps cards ⇄ 22px rows. Card layout, markup
and CSS are unchanged from before view modes; only the compact row is new. A
compact row carries two icon columns: the kind glyph leads, the artifact logo
sits at the trailing end beside the state slot. Both are bare glyphs — the
card's tinted tile background is a card affordance and reads as a box around a
smudge at 16px.

**Tree** — the `list-tree` icon. Expect, with the `project` config:

```
primary                          <- the registry ALIAS, its oci prefix stripped below
  playbooks/ci/release           <- ONE folded node, not three (single-child chain)
    cut-release
  agents/ bundles/ rules/ skills/
```

With the `project` workspace exactly one registry resolves, so that root elides
and `agents/ bundles/ playbooks-ci-release/ rules/ skills/` become the top level.
The `project-multi` workspace shows both roots (`primary`, `tools`).

This is grim's own TUI tree shape (`grim tui`, press `t`) — the two should
agree. In tree mode the grouping icon's slot becomes a SINGLE expand/collapse
button: it offers Collapse All while anything is open and Expand All once
everything is shut, so the icon count never changes with the mode and no button
shifts position.

**Grouping** — the group icon toggles it (list mode only; it swaps to
`ungroup-by-ref-type` while grouped). Browse groups by CONFIGURED registry,
named by the alias from `grimoire.toml` (`primary`, `tools`) rather than by
host, so two aliases sharing a host stay two groups. The alias comes from the
per-row `source` in `grim search --format json`, which is also how an
INDEX-served row gets rooted under the index's alias — its locator prefixes no
repo, so nothing else could attribute it. A row with no `source` (an
installed-only card — `grim status` carries no registry attribution) falls back
to the longest configured prefix, then the bare host. An entry with no alias is
labelled by its locator. Installed groups by scope, and there is no
Project/Global toggle any more — both scopes are on screen at once. There is no
group-by-kind: the Kind chips already do that.

**Row columns** — leading: the published logo, or a monogram chip (up to two
initials, one of six tints hashed off the repo) when the artifact has none.
Trailing, in order: the gear that opens the shared card menu, the kind glyph,
then the state slot.

**Trailing slot** — the fixed box at the end of each compact row:
`⬇` not installed · `⟳` update available · `⚠` local files modified or missing ·
`ℹ` install incomplete (outputs pending) · a dot for installed-and-clean · empty
when install state is unknown.

**Persistence** — set a density/mode/grouping, expand a few nodes, then
_Developer: Reload Window_. All of it survives. Density / list-vs-tree /
grouping are a PREFERENCE, stored host-side in `globalState` and written only
when you actively switch one, so they also survive quitting VS Code and come
back in a different window. The expanded node set stays webview-side — it
belongs to this list, not to you.

**Updates tab** — honours density, and nothing else: it is a short
single-purpose list that never trees or groups, so its title bar drops those
controls (`grimoire.view.structured`) rather than offering toggles whose effect
never shows up.

## 3b. If Browse shows no `localhost:*` rows

The local rig registries speak plain HTTP. Unless the host is in grim's
plain-HTTP set, grim cannot reach them. `search --format json` still exits 0,
but its `sources` array marks that registry `ok: false` with the error. The
sidebar footer turns into a warning ("A registry could not be read in full").
Clicking it opens the Grimoire output channel, which names the registry and
the error. Browse comes back short meanwhile, while `grim status` keeps listing
the artifacts already on disk, so Installed shows registries Browse does not.

Two ways in, and they add up (nothing takes a host back out):

- **Per registry, in the config** — `insecure = true` on the `[[registries]]`
  entry (grim 0.13.0+). This is what the Settings panel edits: the registry
  form's **Plain-HTTP transport** checkbox, on the OCI kind only (an index
  locator carries its own scheme, and grim rejects the flag there with exit 65).
  A row that opted in carries an unlock mark beside its alias. The host matches
  **exactly, including the port** — `localhost:5050` and `localhost` are
  different hosts.
- **Per process, in the environment** — `GRIM_INSECURE_REGISTRIES=localhost:5050,localhost:5051`,
  still the way to reach a host no entry declares. Outside the rig it goes in
  the `grimoire.extraEnv` setting, which is passed to every grim child process:

  ```jsonc
  "grimoire.extraEnv": { "GRIM_INSECURE_REGISTRIES": "localhost:5050" }
  ```

Both rig launch configs set the variable. Plain **Run Extension** does not — use
a rig config, or declare `insecure = true` on the entry, or the local registries
stay invisible to Browse.

Worth testing on the rig: tick the checkbox on a `localhost:5050` OCI entry,
save, and confirm the mark appears and Browse fills in. `grim context
--format json` reports the **authored** field — a host reached over HTTP through
the implicit loopback set (`localhost`, `127.0.0.1`, bare and on `:5000`) or
through the environment variable still reports `insecure: false`, so an unmarked
row that browses fine is not a bug.

## 4. Producing the interesting states

```sh
# modified — tamper with an installed file, then Refresh Catalog in the sidebar
echo x >> test/manual/project/.claude/skills/hello-world/SKILL.md

# missing — delete an installed artifact's files
rm -rf test/manual/project/.claude/rules/architecture-guide

# outdated — publish a newer version (already done in step 1)
test/manual/scripts/release-update.sh

# deprecated — old-reviewer ships metadata.deprecated; find it in Browse
grim search old-reviewer

# outputs pending — give autodetect a client the last install did not write for.
# The install record still covers only .claude, so `grim status` reports the
# cursor outputs an install WOULD write: the row keeps its dot-clean version but
# gains the ℹ "Install incomplete" hint and a Complete Install action.
mkdir -p test/manual/project/.cursor/rules
```

Install state unknown (the banner, and the empty trailing slots that go with
it): launch with `GRIM_HOME` pointing at a path that does not exist, or stop the
registries with `docker compose -f test/manual/docker-compose.yml down` and hit
Refresh.

## Ratings and download counts

> **Launch via a rig config, not a normal window.** Both signals need a `grim`
> new enough to emit them *and* this working copy's extension. A normal VS Code
> window gives you neither: it runs the **installed** extension from the
> marketplace and the `grim` on your own `PATH`. Only the
> "Run Extension (manual rig — …)" configs put `../grimoire/test/bin` first on
> `PATH`, and only the Extension Development Host shadows the installed build.
> If the rows appear but carry no badge, check `grim --version` inside the
> debug host against the rig's binary — a `grim` that predates the field simply
> omits the key, and every row reads as uncounted with no error anywhere.

Both come from the index's `stats.json` sidecar, and the sidecar rides the
**HTTP index transport only** — an OCI `_catalog` browse has none to fetch. The
rig serves one from the `index` compose service on port 5052 (`grimoire`'s
`test/manual/index/`), declared in `project/grimoire.toml` and in the rig's
global config, so both signals are reachable in review. Before that service
existed every row in the rig was permanently unrated and uncounted.

Because the index lists the **same refs** the OCI registry serves, the browse
shows a second tree root carrying the same artifacts. That is real grim
behaviour — one repository served by two configured registries appears once per
registry — not a rig artefact.

What to look at:

| Row | Expect |
|---|---|
| `code-reviewer` | Rating badge **and** download badge on the card. In the rail, a **DOWNLOADS** panel: `Total 1,416`, the displayed release `1.2.0` under it. `1.1.0`/`1.0.0` are not listed, and no "as of" date — the stamp lives in the card badge's tooltip only. The total is not the displayed release's figure, and must not be shown as if it were. |
| `support-desk` | Counted, unrated — `250K` on the badge, the exact figure in its tooltip. |
| `commit-helper` | Rated, **uncounted**: no download badge, and no `Downloads` row in the rail. Absence is unknown, not zero. |
| `reviewer` | A measured **zero**: the badge renders `0`. It must not look like the row above. |
| `rust-style` | A count with no stamp — the badge tooltip shows the bare figure. |
| `security-baseline` | A stamp three months old in the badge tooltip. |
| a restored details tab | Close the sidebar, restart the debug host with the tab open: the DOWNLOADS and RATING panels are there on the first paint, with no sidebar refresh. |
| the panel's placement | It is its **own** panel, not a row inside RATING. Check it on an unrated-but-counted row (`support-desk`): RATING omits itself entirely there, and the count must survive that. |
| `rust-style` / `support-desk` | No breakdown published — the total stands alone. |

The sort control gains a **downloads** entry beside `rating`. Uncounted rows
bucket at the end — under the measured `0`, never merged with it.

The card glyph is lucide's arrow-down-to-line, the same mark the index site
puts on its download counts, so one signal reads identically on both surfaces.

`test/manual/index/README.md` in the `grimoire` checkout gives the row-by-row
rationale, and the fixture is served straight off disk: edit `stats.json`, hit
Refresh, no restart.

## Curated annotations and support channels

The rig's `support-desk` skill is the annotation showcase: it publishes every
curated field (`authors`, `vendor`, `url`, `documentation`, `compatibility`) plus
all four support channels, with `contact` as a bare email address. Its details
panel is the one that paints a full RESOURCES panel, a PACKAGE **Compatibility**
row and a SUPPORT panel. `hello-world` in the same rig is the empty case — a
derived `vendor` and nothing else, so no SUPPORT panel at all.

Support channels ride the description companion, not the version manifest, so
editing one moves the companion digest while every artifact digest stays put.
The details cache compares both, so reopening the panel picks the new link up on
revalidate — `../grimoire/test/manual/README.md` walks that demo.

The same pair backs the live contract test, which self-skips unless pointed at a
resolvable reference:

```sh
cd ../grimoire && test/manual/scripts/bootstrap.sh
cd -
GRIM_LIVE_ANNOTATED_REF=localhost:5050/grimoire/skills/support-desk \
  GRIM_INSECURE_REGISTRIES=localhost:5050,localhost:5060 xvfb-run -a npm test
```

## Browsing 20,000 rows (release checklist)

The Browse list keeps only the rows near the viewport in the DOM, and the host
posts it to the webview in parts of at most 1,000 cards. Unit tests cover the
windowing math, the rendered row count and the post sizes. They cannot reach a
real webview's focus, keyboard, scroll or memory, so run this check before a
release that touches the sidebar list. It needs grim 0.15.0 or newer; an older
grim lists only the first 500 entries of an index.

Build a synthetic index of 20,000 entries and serve it on loopback:

```sh
mkdir -p /tmp/grim-20k/idx /tmp/grim-20k/home
python3 - <<'EOF'
import json
entries = [{"schema": 1, "name": f"pkg-{i:05d}", "kind": "skill",
            "ref": f"ghcr.io/acme/skills/pkg-{i:05d}",
            "summary": "Synthetic entry for the 20,000-row browse check",
            "description": "Synthetic entry for the 20,000-row browse check. " * (1 + i % 5),
            "repository": "https://github.com/acme/skills"} for i in range(20000)]
open("/tmp/grim-20k/idx/all.json", "w").write(json.dumps(entries))
EOF
printf '[[registries]]\nalias = "big"\nindex = "http://127.0.0.1:8020"\ndefault = true\n' \
  > /tmp/grim-20k/home/grimoire.toml
python3 -m http.server 8020 --bind 127.0.0.1 --directory /tmp/grim-20k/idx
```

Launch **Run Extension**, and in the development host's user settings point
grim at that home: `"grimoire.extraEnv": { "GRIM_HOME": "/tmp/grim-20k/home" }`.
Open Browse with an empty query and check each item below. Check them in
comfortable cards, compact rows, grouped, and tree mode.

- [ ] **Loads.** The summary counts up to 20,000 results while pages load in the
  background, and the footer shows no warning.
- [ ] **Window.** In **Developer: Open Webview Developer Tools**, the results
  container holds at most about 200 rows at any scroll position.
- [ ] **Scroll.** Drag the scrollbar to the middle and to the end. Rows appear
  without gaps, and the scrollbar does not jump while you scroll back up.
- [ ] **Keyboard.** Click a row, then press Down, Up, Page Down, Page Up, End
  and Home. Focus moves row by row, and End reaches `pkg-19999`. The focused
  row stays in view with a visible focus ring.
- [ ] **Tab.** Tab out of the list and back in. Focus returns to the row you
  left, not to the top of the list. The next Tab reaches that row's own
  buttons (Install, the gear); the buttons of every other row are skipped, and
  Shift+Tab from the footer lands on the same row, not on the last one drawn.
- [ ] **Enter and Space.** Enter or Space on a focused card or compact row
  opens its details preview, and Space does not scroll the list. In grouped
  and tree mode, Enter and Space on a header still expand or collapse it.
- [ ] **Scrolling away from a focused row.** Focus a row, then scroll with the
  mouse wheel and the scrollbar well past it (more than a screen) and back.
  The row keeps focus the whole time: `document.activeElement` in the webview
  developer tools is still that row while it is off screen, and the focus ring
  is on it when you scroll back.
- [ ] **Tree keys.** In tree mode, Right on a collapsed node expands it and
  Right on an expanded node moves to its first child. Left on an expanded node
  collapses it, and Left on a collapsed node or a leaf moves to its parent.
  Right on a leaf and Left on a collapsed top-level node do nothing.
- [ ] **Installed tab.** With more than about 200 artifacts installed (publish
  a few hundred trivial skills to the rig's local registry and `grim add`
  them), repeat Window, Scroll, Keyboard and Scrolling away from a focused row
  on the Installed tab, grouped by scope and not.
- [ ] **Screen reader.** The webview developer tools' Accessibility pane shows
  `aria-setsize` and `aria-posinset` on rows, plus `aria-level` in the tree. A
  card or compact row is named with its kind and install state, for example
  `pkg-00001, skill, not installed`; an outdated one adds `update to 1.3.0`.
  The tree itself has a name.
- [ ] **Screen reader pass.** With NVDA on Windows and VoiceOver on macOS, walk
  the list with the arrow keys all the way to `pkg-19999` in the flat list, the
  grouped list and the tree. Each row is announced with its name, kind, state
  and position, and keys keep moving after the last mounted row. The decision
  on the list container's role (`feed` for the flat list, a tree-like role for
  grouped) waits for this pass.
- [ ] **Memory.** Once all pages are loaded, read the JS heap size in the
  webview developer tools (Memory tab or Performance monitor). Write it down
  beside the previous release's figure; a large jump is a regression.

Find in page only finds rows near the viewport. That is the accepted cost of
the window, not a defect.

## Notes

- The rig's registries are plain HTTP; `GRIM_INSECURE_REGISTRIES` in the launch
  config is what makes that work, and it is scoped to the debug session. The
  per-entry `insecure = true` is the other half — see §3b.
- `grim tui` in the same shell is the cross-check for anything tree-shaped —
  see `../grimoire/test/manual/README.md` scenarios 1a and 1c.
