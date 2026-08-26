# Handover: display grim's new annotation fields

From `grimoire` [#106](https://github.com/grimoire-rs/grimoire/issues/106)
("More annotation data"). The grim side is **shipped**; this is the extension's
half. Nothing here is blocking — the details view keeps working untouched, it
just shows less than it now can.

Grim-side rationale and full contract:
`grimoire/.agents/adr/adr_default_provenance_and_support_channels.md`.
Where each field is allowed to surface: `docs/src/publishing.md#metadata-surfaces`.

## Read this first: no version gate

Every field below is **additive and nullable** on grim's frozen JSON interface.
Per `.claude/rules/grim-compat-markers.md`, that means a read-site guard and
**never** a `MINIMUM_GRIM_VERSION` bump and **never** a `grim-polyfill<` marker.
An older grim omits the key; `?? null` is the entire compatibility story. The
floor stays at `0.11.0`.

## What changed upstream

1. **Build provenance is derived by default.** `revision` and `created` are
   emitted on every `build`/`release`/`publish`, not only under `--git`. The
   extension already renders `created` as the PACKAGE panel's **Published** row
   (`model.ts` `published`, `render.ts` `renderPackagePanel`) and `revision`
   beside it — both were usually `null` in practice and now usually are not.
   No code change; expect the rows to start appearing on ordinary packages.
   - `created` is the **commit date**, never a wall clock, so it is stable per
     digest. Still `null` for an artifact published outside a repository or
     with `--no-git`.
2. **Five new curated fields** on `DescribeResult` (`src/grim.ts`, ~line 180):
   `authors`, `vendor`, `url`, `documentation`, `compatibility` — all
   `string | null`.
3. **A `support` object**, `{issues, chat, contact, security}`, each
   `string | null`. Read off the **description companion's** manifest, not the
   version's.

`SearchItem` gains an `oci` object carrying `{licenses, authors, url,
documentation, vendor, compatibility}` — useful only if you want a browse-row
fallback the way `published` already falls back to `searchItem.created`.
`support` is deliberately **not** there; see below.

## 1. Types and VM

- `src/grim.ts` — add the five fields plus `support?: {…}` to `DescribeResult`.
  Keep them optional-and-nullable, same tolerance pattern as
  `has_description?: boolean` directly above.
- `src/webview/protocol.ts` — `DetailsVM` gains the display fields. The existing
  panel comments (`/** Resources panel. */`) are the right grouping.
- `src/webview/model.ts` — `buildDetailsVM` (~line 1759). Follow the existing
  fallback chains: `describe?.authors ?? frontmatter?.authors ?? null` where a
  frontmatter source exists, plain `describe?.x ?? null` where it does not.
  Both files stay free of vscode/DOM imports (AGENTS.md).

## 2. Where each field goes

| Field           | Panel         | Shape                                               |
| --------------- | ------------- | --------------------------------------------------- |
| `authors`       | RESOURCES     | static row, `codicon-organization`                  |
| `vendor`        | RESOURCES     | static row beside `authors`                         |
| `url`           | RESOURCES     | link row, next to **Source repository**             |
| `documentation` | RESOURCES     | link row, `codicon-book`                            |
| `compatibility` | PACKAGE       | plain row; skills only, `null` for every other kind |
| `support.*`     | **new panel** | see below                                           |

`renderResourcesPanel` (`render.ts:1051`) already has both shapes — a
`.rail-link-row` with an `data-action="open"` anchor, and a `.resource-link
static` span for non-links. Its early-out
(`if (!vm.sourceRepository && !vm.license) return nothing`) must widen to
include the new fields or an artifact carrying only `documentation` renders no
panel.

**Support gets its own panel**, not a row in RESOURCES: a `SUPPORT` rail panel
(mirroring `renderRatingPanel`, `render.ts:176`) with up to four link rows —
issue tracker, chat, contact (`mailto:` when it is an address), security.
Render `nothing` when all four are null, which is most packages today.

`contact` may be a bare email address rather than a URL. Do not construct a
`mailto:` from an arbitrary string without checking it — treat a value with no
scheme and no `@` as plain text, not a link. Every link goes through the
existing `data-action="open"` handler, which is the only sanctioned path out.

## 3. `support` is mutable — and the cache already handles it

This is the one design consequence worth understanding before touching
`detailsCache.ts`.

Support channels ride the **companion** manifest so a moved chat link updates
every already-published version without a re-release. That means the value can
change with **no digest change on any artifact**.

The extension is already correct here, by accident of good design:
`contentUnchanged` (`src/views/details.ts:1316`) compares _both_
`artifactDigest` and `companionDigest`, and a `[description.support]` edit
re-points the companion tag, so the companion digest moves and the SWR
short-circuit correctly declines. **No cache work is needed.** Do not key
support freshness off `artifactDigest` — that is the one wiring that would be
silently wrong.

The cached paint may briefly show a stale link before revalidate lands. That is
the existing SWR contract and is fine.

## 4. Why `support` is not on browse rows

grim withholds it from `grim search` and its own TUI on purpose: both read a
disk-cached catalog, and a cached contact link is a link that may already have
moved. `grim describe` is the live surface. Mirror that — no support in the
browse list, no fallback to a `searchItem` field, because there is none.

## 5. Testing

Real data, not a hand-written fixture: the grimoire repo's manual rig publishes
one artifact carrying every field including support channels.

```sh
cd ~/dev/grimoire            # or the active worktree
test/manual/scripts/bootstrap.sh
grim describe localhost:5050/grimoire/skills/support-desk --format json |
  jq '{created, revision, authors, vendor, url, documentation, compatibility, support}'
```

Scenario 9 in `test/manual/README.md` walks every read surface, and ends with a
demo that changes a support link and shows the artifact digest **not** moving —
which is exactly the case § 3 describes. Point the extension at
`localhost:5050` and reopen the details panel to watch revalidate pick it up.

For the unit suite, keep the empty case covered too: `hello-world` in the same
rig has a derived `vendor`, no `support`, and no `compatibility`, so both
branches are reachable against real payloads.
