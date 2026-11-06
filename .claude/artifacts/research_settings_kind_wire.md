# Research: grim's `settings` kind on the wire

What the extension reads when grim reports an experimental `settings` package,
and which identifiers are new. Written for the plan that teaches the extension
the kind (grimoire issue #272). Source of truth is grim, not this file: re-read
it when grim ships the kind.

## Sources

- grim branch `hex/config-artifact-type`, final for grimoire PR #318 (head
  `ef2f133`, merged to main as `c5e3824` with the same tree, unreleased):
  `docs/src/content/docs/settings.md`,
  `docs/src/content/docs/json-interface.md` (Hook arming table, report shapes,
  error document), `.agents/adr/adr_settings_artifact_kind.md` (consent
  prompt, compatibility table), `src/api/artifact_status.rs`
  (`HookArmingCause`), `src/command/status.rs` (`settings_arming`),
  `src/hook/trust.rs` (consent wording).
- A recorded run of that tree's release binary (`grim 0.15.1`) in a sandbox:
  fake `HOME`, private `GRIM_HOME`, a private zot on a loopback port. The
  package is the manual rig's `team-defaults` (Claude scalar, set and map
  pieces at project scope, Codex and Copilot tables at global scope).
  Sanitized copies are the fixtures under
  `src/test/fixtures/grim/0.15.1-settings/` (paths → `/home/u`, registry →
  `ghcr.io/acme`), with recorded exit codes in `exits.json`. The first
  recording (branch at `3b9e32b`, 2026-11-05) was replaced by this one.

## The kind

- `kind` literal `settings` on every report; `[settings]` table in
  `grimoire.toml`; `com.grimoire.kind=settings`; layer media type
  `application/vnd.grimoire.settings.v1+json`.
- `grim fetch` returns the package as pretty JSON with sorted keys (per-harness
  tables plus `description`, `summary`, `keywords`).
- `grim describe` reports `has_description: false` for a package with no
  companion; `fetch --description` then exits 79.
- `grim uninstall settings <name>` is the inverse; `remove` is bundle-only.
- Search has no `--kind` flag; the extension filters kinds client-side.

## Status rows

A settings row is a normal status row. It reuses the hook kind's `arming`
array (`{client, cause, message, transient}`, `[]` when nothing holds it
back) and adds no `state` token: `installed`, `modified`, `missing`,
`outdated`, `stale`, `gated`, `not-armed`. `untrusted` stays hook-only.

grim keeps `clients_missing` at `[]` on every settings row: an install records
a client only for the values the package declares, which `status` cannot see.
`clients_extra` comes from the install record and can be non-empty
(`status-no-applicable` lists `claude`). The two recorded gated rows were never
installed, so both lists are `[]` there and no Client drift badge shows beside
"Settings not applied". The first recording listed the gated client as missing.

A gate never removes values grim already wrote: clearing the flag, revoking
consent and a root fence all leave them in place, and `outputs` still lists
them. A row a gate holds back while it has outputs therefore reads "held
back" rather than "not applied". A note (`local-file-tracked`,
`client-config-absent`, `no-applicable-settings`) is not a gate: a row it alone
holds reads "not applied". A `stale` row keeps its gate in `arming` only.

`outputs` carries one entry per piece, so one client repeats once per value
(`team-defaults` gives four `claude` entries for one file). Each entry gains an
always-present `element` (the set element, else `null`). `outputs_pending` is
always `[]` for settings.

## Causes

Every cause is an `arming[].cause` verdict with exit 0. grim's error document
gains no new `reason`. Each `message` ends with its remedy; at global scope the
remedy names `grim install --global`.

| Cause | New | Recorded state | Meaning |
|---|---|---|---|
| `feature-flag-off` | reused | `gated` | `[options.experimental] settings` is off; message names `grim config set options.experimental.settings true` |
| `workspace-not-consented` | reused | `gated` | No consent record; message names `grim consent allow` / `--trust-workspace` |
| `consent-drifted` | reused | `gated` | The record no longer covers a binding or repository |
| `not-registered`, `grim-home-relative`, `grim-home-in-workspace`, `grim-home-shared` | reused | `not-armed` | grim refuses to write there |
| `no-applicable-settings` | **new** | `gated` only when nothing applies to any selected client, else a note on an applied row | Nothing in the package targets that client at this scope |
| `client-config-absent` | **new** | `gated` when no selected client can take a piece | The harness writes only into a file that exists (Cursor CLI) |
| `local-file-tracked` | **new** | never moves `state` (recorded `installed`) | git tracks `.claude/settings.local.json`, so grim's values can reach a commit |
| `settings-root-relative` | **new** | `not-armed` (recorded, global) | A vendor variable (recorded: `CODEX_HOME`) makes the client's settings root a relative path |
| `settings-root-in-workspace` | **new** | `not-armed` (recorded, global) | The client's settings file lies inside the repository the command runs in |

`client-config-absent` moves `state` only when no selected client can take a
piece, and `no-applicable-settings` reads `gated` only when nothing applies to
any selected client; otherwise each is a note on one client. The two root-fence
causes are global only: grim leaves the file untouched, keeps any value it
wrote earlier with its record and pin, and the `install` report does not carry
the refusal (only `grim status` does). No flag or consent clears them, so the
extension prompts nothing for them.

json-interface.md: treat an unknown `cause` as "not armed, reason unknown" and
show `message`. Branch on `cause`, never on `message`.

## Consent and the flag

- One consent record per workspace for both kinds. `grim hook allow` records
  both kinds whatever the flags say; `grim consent` is a visible alias that
  only a settings-aware grim has. Global scope is always consented.
- The ADR's prompt has one noun slot: `Hooks`, `Settings` or `Hooks and
  settings`, with the settings clause "Settings change how your AI client
  behaves and what it may do."
- grim's own consent wording is per noun: a settings run that cannot record
  consent says "workspace consent could not be recorded; nothing applied", a
  mixed run "…; nothing armed or applied", and a decline "settings in '<dir>'
  were declined; nothing applied". The extension never prompts through grim
  (`grim hook allow` runs without a terminal), so it shows none of these.
- The flag is `options.experimental.settings` (`grim config list --all`
  reports it in section `experimental`, title "Experimental settings").

## Action reports and refusals

- `install`, `add`, `update` and `uninstall` reports carry a top-level
  `settings_changes` list (`{package, client, file, key, element, action}`,
  never values). grim prints the same list on stderr with the note "a running
  client may need a restart to read its new settings".
- Status `outputs` and every `abandoned_entries` object carry `element`. A
  settings value grim adopted stays in the file on uninstall and is named in
  `abandoned_entries`, and an adopted MCP entry a reap leaves behind is named
  there too. The extension reads neither list.
- A hand-edited value refuses `install`/`add` with the existing forceable
  error (`code: data`, exit 65, `reason: modified`, `forceable: true`) plus
  `error.pieces`: `{package, client, file, pointer, element, marked, state,
  wanted, current}`. `current` is the user's value (screened by grim). The
  message reads "N settings value(s) were set or changed outside grim; rerun
  with --force to change them".
- `update` reports the refusal as a normal report (exit 65, the row
  `refused: true`) with a top-level `pieces` list of the same shape.
- A cross-package conflict is `code: config`, exit 78, no `reason`, pieces
  `marked: conflict`, not forceable. An unparseable settings file is exit 65
  with no `reason`, not forceable.
- A settings file that changed while grim was writing it is left untouched:
  exit 75, `reason: locked`, `retryable: true`. Add, update and install show it
  in the generic failure toast, whose message from grim says to rerun.
- A settings document naming a field grim does not know carries the error
  document's `hint`; `install` adds `reason: unsupported-artifact-feature`.

## Observations for grim

- `fetch --description` on a settings package with no companion fails with a
  message that names the kind `skill` (`skill 'team-defaults' (…:__grimoire):
  tag not found`), still so at `ef2f133`; grimoire issue #301 tracks it. The
  extension never makes that call when `describe` says `has_description:
  false`, so this is a grim wording issue only.

## Search terms

`HookArmingCause`, `settings_arming`, `settings_changes`, `error.pieces`,
`no-applicable-settings`, `client-config-absent`, `local-file-tracked`,
`settings-root-relative`, `settings-root-in-workspace`,
`options.experimental.settings`, `grim consent allow`.
