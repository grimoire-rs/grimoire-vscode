---
paths:
  - 'src/webview/protocol.ts'
  - 'src/webview/model.ts'
  - 'src/webview/render.ts'
  - 'src/webview/**/*.css'
  - 'src/grim.ts'
  - 'src/scopes.ts'
  - 'src/gatePrompt.ts'
  - 'src/views/details.ts'
  - 'src/views/hookPrompt.ts'
  - 'src/test/kinds.test.ts'
  - 'src/test/escaping.test.ts'
  - 'src/test/grimLive.test.ts'
  - 'src/test/fixtures/grim/**'
---

# Artifact kinds: interfaces, sites and consumers

Kinds are `KINDS` in `src/webview/model.ts` (the `ArtifactKind` union in
`src/webview/protocol.ts`): skill, rule, agent, mcp, bundle, hook, settings,
mod. grim's own list is `ArtifactKind::ALL`; its rule
`../grimoire/.claude/rules/artifact-kinds.md` owns the CLI side.

## Interfaces this extension faces

grim's `--format json` output, all through `src/grim.ts`: `search` (registry
and index rows), `describe`, `fetch` (document, `--path` for logo, README and
CHANGELOG), `status` (incl. `arming`, `serves`), the `add`/`install`/`update`
report, `uninstall`/`remove`, `config set` (feature flags), `hook allow`
(consent). Its own surfaces: browse and installed cards, the kind filter chips,
the details view (header, rail, CONTENTS body), the gate prompts, and the
declared tables read from `grimoire.toml`.

## Kind x interface

Every kind is supported and tested on every interface above, except these
refusals. Each is on purpose; a refusal not listed here is a defect.

| Cell | Decided by | Checked consumer |
|---|---|---|
| `serves` badges: mod only, `null` elsewhere | grim ADR `adr_mod_artifact_kind.md` D9 | `readServes`; `kinds.test.ts` recorded coverage |
| Harness chips in CONTENTS: settings and mod only | ADR rollout item 10; settings since `3cfd2ea` | `groupModHarnesses`, `renderContentsBody`; `modDetails.test.ts` |
| Gate prompts: hook, settings, mod only | grim `consent::is_gated`, ADR D6 | `src/gatePrompt.ts` `KINDS`; `hookPrompt.test.ts` |
| `arming` wording: hook, settings, mod only (a mod is never "armed") | ADR D8 | `armingLabel`, `unarmedTooltip`; `model.test.ts` |
| `fetch --path`: only kinds whose fetch lists `files`; bundle, mcp, settings never send it (grim exits 1) | grim `src/fetch.rs` arms (no ADR line) | `fetchLogo`, `fetchDoc` in `src/views/details.ts` need a `files` hit |
| `fetch --vendor`: never sent (grim refuses it for a mod) | ADR D13 | `fetchArgs` has no `vendor` caller |
| Uninstall a bundle: `remove`, not `uninstall` (grim exits 64) | grim's `uninstall` kind set (no ADR line) | `uninstallOrRemoveArgs`; `extension.test.ts` (bundle uninstall runs `remove`) |
| Live mod cases skip on a grim without the kind | CI pin is v0.16.0 | `grimLive.test.ts` (`grim schema --kind mod` probe) |

## Sites a new kind must reach

The compiler enforces the `Record<ArtifactKind, …>` ones; `kinds.test.ts`
enforces the rest and fails until each is done.

1. `ArtifactKind` (`protocol.ts`), `KINDS`, `KIND_ICONS` (an existing codicon),
   `KIND_LABELS` (`model.ts`); `KIND_CHIPS` derives from them (`render.ts`).
2. `.kind-<k>` tint in `details/details.css` and `sidebar/sidebar.css`.
3. `KIND_TABLES` (`src/scopes.ts`) for the `grimoire.toml` table.
4. Details body: `buildDetailsVM` content shaping and `renderContentsBody`.
5. Wire types in `src/grim.ts` (`SearchItem`, `StatusItem`, `DescribeResult`)
   and `model.ts`; every new field optional, guarded at its read site
   (`grim-compat-markers.md`).
6. Gated kinds only: `src/gatePrompt.ts` (`GatedKind`, the flag gate,
   `CONSENT_PARTS`, `declinedKey`) and the arming wording in `model.ts`.
7. Recordings in `src/test/fixtures/grim/<version>/` via `record-kinds.sh`, one
   card and one details golden per kind (`goldens/index.json`), a source
   writer in `grimLive.test.ts`, an escaping case in `escaping.test.ts`.
8. Docs once, after the code: `README.md` (kind list, chip row, gates, version
   needs), `CLAUDE.md` (kind list, codicons), `package.json` description.

Nothing may key on a harness name: harness names come from grim
(`[a-z0-9]+`) and an unknown one renders as plain text.

## Other repos and release order

- `grimoire-rs/grimoire` (grim): every interface above. Its JSON is additive.
- `grimoire-rs/indexer`: read only through grim (index-backed `search` rows:
  `summary`, `keywords`, `serves`, `replaced_by`). Its catalog site shows the
  kind marks this extension uses (codicons above), so change one, tell it.

Release order for a new kind: indexer, then grim, then this extension. The CI
pin (`GRIM_COMMIT` in `.github/workflows/ci.yml`) moves to the grim release
that ships the kind; then the live mod cases run instead of skipping, with no
test edit.

## Acceptance tests

`src/test/kinds.test.ts` (every kind at every site), `escaping.test.ts`
(every render path), `modDetails.test.ts`, `hookPrompt.test.ts`,
`grimLive.test.ts` (search, describe, fetch, status per kind against a real
grim and registry), `parity.test.ts` (goldens), `recorded0160.test.ts`.
