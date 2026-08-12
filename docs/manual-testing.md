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
a dot for installed-and-clean · empty when install state is unknown.

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

The local rig registries speak plain HTTP. Without
`GRIM_INSECURE_REGISTRIES=localhost:5050,localhost:5051` in the extension host's
environment, grim cannot reach them and reports
`catalog for source 'localhost:5050' unavailable: … registry access failed` —
on **stderr**, as a tracing WARN. `search --format json`'s envelope is `{items}`
alone, with no warnings channel, so the extension cannot surface it: Browse
simply comes back short while `grim status` keeps listing the artifacts already
on disk, i.e. Installed shows registries Browse does not.

Both rig launch configs set that variable. Plain **Run Extension** does not — use
a rig config, or the local registries stay invisible to Browse.

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
```

Install state unknown (the banner, and the empty trailing slots that go with
it): launch with `GRIM_HOME` pointing at a path that does not exist, or stop the
registries with `docker compose -f test/manual/docker-compose.yml down` and hit
Refresh.

## Notes

- The rig's registries are plain HTTP; `GRIM_INSECURE_REGISTRIES` in the launch
  config is what makes that work, and it is scoped to the debug session.
- `grim tui` in the same shell is the cross-check for anything tree-shaped —
  see `../grimoire/test/manual/README.md` scenarios 1a and 1c.
