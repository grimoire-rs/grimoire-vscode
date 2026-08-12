# ADR: probe truth in the details cache — who owns `complete`, the digests, and the paint

- **Status**: Proposed (2026-08-12)
- **Context**: repair of the `/hex-review high` findings on
  `feat/cache-freshness-and-outputs-pending` — B1, H2, H5, H8 and the
  `complete`-from-fresh defect (discovery digest §A.3). All five are one
  question wearing five hats.
- **Scope**: `grimoire-vscode` only. No grim change, no wire-format change, no
  new runtime dependency.
- **Constraint (owner, 2026-08-12)**: **no hard breaking change to config or
  persisted state.** A `CACHE_VERSION` bump self-purges every entry and charges
  every user a full cold sweep — that is a state reset, not a defect repair, and
  it is rejected by default. No change to `contributes.configuration` setting
  IDs, types or defaults (a `description` string is not schema and is in scope
  for the doc findings). New fields on `DetailsCacheEntry` must be **additive
  and optional**, degrading safely for entries written before them — the way
  `complete` itself landed. A required field, or a changed meaning for an
  existing one, is out.
- **Supersedes**: nothing. **Amends**: the field docs on
  `DetailsCacheEntry.complete` and `artifactDigest` (`src/detailsCache.ts:19-40`)
  and `mergeEntry`'s contract (`:42-66`), which today describe a merge that is
  unconditional and a `complete` that is copied from the probe.
- **Binding precedent**: `adr_anchor_escape_recovery.md` Decision 3 — a
  scope-wide refusal gets a naming-and-navigate dialog, never a force
  affordance. That settles H4's shape and this ADR does not revisit it.

## Context

`DetailsManager` runs a content pipeline (describe + `fetch` + companion +
per-path doc fetches) and persists the result as a `DetailsCacheEntry`. Every
sub-probe unwraps its `GrimResult<T>` to `T | null` at its own helper
(`describe` `:643`, `v2Companion` `:729`, `fetchLogo` `:661`, `fetchDoc` `:687`,
`digestOnly` `:1006`). From that point on, "grim failed" and "the artifact
publishes nothing here" are the same value.

The branch already noticed one consequence — a failed probe stamped a null logo
over a good cached one, and browse-list logos vanished — and fixed it with two
mechanisms: `mergeEntry`, which folds cached content under fresh nulls, and a
`complete` flag that shortens the retry TTL when the probe missed something.
Both mechanisms are correct in isolation. What the review found is that the rest
of the code does not agree with them about which artifact is the truth:

- `saveEntry` writes the **merged** entry and returns `void`; `buildVM` and
  `revalidate` paint the **raw** VM from `buildPipeline`. The cache is repaired
  and the open panel is not (B1) — and because every `postVM` caller inherits
  this, it fires after every install, update, uninstall and complete-install.
- `contentUnchanged` folds "no companion" and "the companion digest probe
  failed" into one null before comparing it to a cached null, so a failed probe
  can *prove* freshness and re-stamp a 6 h TTL over content it never saw (H2).
- `mergeEntry` merges unconditionally, so content a publisher deliberately
  deleted resurrects and is re-pinned under the new digest (H5).
- `mergeEntry` takes `complete` and `artifactDigest` straight from `...fresh`,
  so an entry whose content the merge just made whole still reads
  `complete: false` (digest §A.3).
- A probe that fails outright writes nothing at all, so `isFresh` is false
  forever and every viewport report re-queues the same failing repo (H8).

The unifying defect is not "null is ambiguous". It is that **`complete` and
`artifactDigest` describe the probe that just ran, while every reader treats
them as describing the entry on disk.** This ADR fixes the ownership, not the
nullability.

## Decision 1 — two questions, two owners

Split the one thing the code conflates:

> **What do I paint?** → the **merged** entry, always. It is the only artifact
> that is never worse than what was on screen a moment ago.
>
> **May I skip the next probe?** → `complete` + the two digests, which describe
> the **probe**, and are never improved by merging.

Concretely: `saveEntry` returns the merged entry it wrote, and every caller that
posts to a panel builds its VM from that return value via `vmFromCache`. The
repost gate stops comparing digests — which are probe metadata — and compares
the five fields `vmFromCache` actually reads (`describe`, `fetch`, `readme`,
`logoUri`, `changelog`). One truth reaches the disk, the sidebar card and the
open panel, because all three now read the same object.

**Why the repost gate has to change too.** Digest-only comparison is wrong in
both directions: a partly-failed re-probe nulls `artifactDigest`, so `changed`
is true and the panel repaints with content the cache just preserved; and an
incomplete→still-incomplete retry that recovered a logo has null on both sides,
so `changed` is false and the panel keeps the worse paint. Comparing what the
user sees is the only comparison that answers the question the gate is asking.

## Decision 2 — merging content across digests never confers completeness

`complete` means: *every doc this artifact is known to publish at
`artifactDigest`/`companionDigest` is present in this entry, resolved by a probe
at those digests.* It is written `true` by exactly two paths — a pipeline run
that resolved everything, and a `contentUnchanged` match that proves the cached
content still describes the live digests. A fold never sets it.

This **rejects the review's own RCA remedy** ("compute `complete` from the
merged entry"), and the rejection is the load-bearing call in this ADR, so here
is the counter-example in full:

> An artifact with **no companion at all** (`has_description: false`), cached at
> artifact digest `D1` with in-tree logo `L1`, `complete: true`. The publisher
> republishes as `D2` with a new logo. The logo is still advertised in the
> artifact's `files[]`, but its `--path` fetch fails transiently →
> `logoUri: null` → `missed(LOGO_NAMES, …)` (`details.ts:838`) fires → incomplete.
> `mergeEntry` folds `L1` back in, so the merged entry's content is whole — but
> the logo in it is the old one. Recomputing `complete` from that merged entry
> yields `{complete: true, artifactDigest: D2, companionDigest: null}`. The next
> `contentUnchanged` matches `D2 === D2`, and because `has_description` is false
> it never probes a companion — it compares `null === null` and short-circuits.
> The metadata-only writer then refreshes `savedAt` and keeps `complete: true`.
> `L1` is pinned under `D2` **permanently**, and a panel revalidate
> short-circuits on the same call. The vanished-logo bug returns as a *frozen
> wrong* logo: strictly worse, because it never self-heals.

**Superseded illustration (recorded so it is not re-proposed).** An earlier draft
of this ADR used a companion-failure example — cached `C1`, publisher ships `C2`
plus a new logo, the companion fetch fails. The plan review refuted it: under
Decision 3's `contentUnchanged`, that case reaches the live companion probe, which
returns `C2` against a cached `null`, so it returns **false** and the full pipeline
recovers the new logo. Its real cost is a wrong browse-card logo for ≤6 h, not a
permanent pin. The `has_description: false` case above is the one that genuinely
never self-heals, because no companion probe exists to disagree with the digest.

So the honest state after a fold is `complete: false`, `artifactDigest: null`:
the content is worth painting and is not worth trusting. `isFresh` gives it the
10-minute window and `contentUnchanged`'s first line forces the full pipeline —
both correct, both self-clearing on the first clean probe.

**Accepted cost, stated plainly.** Under a *persistently* failing sub-probe (a
publisher whose `has_description` is true but whose companion tag 404s), that
repo runs a full pipeline every 10 minutes for as long as it stays in the
viewport. State that in spawns, not pipelines, because the pipeline count
understates it ~6×: one pipeline is `describe` + `fetch` + `fetch --description` +
up to three in-tree `--path` fetches (`details.ts:798-806`, `:708-714`) — up to
**six grim spawns per repo per 10 minutes**, and each of the ten `CONCURRENCY`
slots itself fans out ×3, so the real concurrent ceiling is ~30 children.
`CONCURRENCY = 10` bounds concurrency, not volume. It is the price of not lying
about freshness. The upgrade
path, if it is ever measured to matter, is an escalating retry TTL on
consecutive incomplete probes — not a truer-sounding `complete`.

One inconsistency is fixed in the same breath: `prefetchInto`'s metadata-only
branch stamps `complete: true` on a `contentUnchanged` match (promoting a
legacy entry off the short window) and `revalidate`'s identical branch does not.
Both now stamp it — the digest match is the proof, and it is the same proof in
both places.

## Decision 3 — the probe discriminant stays local to the one comparison that needs it

`contentUnchanged` is the only place in the pipeline where "failed" and "absent"
must be told apart, because it is the only place where a null is read as
*proof*. Everywhere else, null already means the right thing:
`incompleteDocs`'s companion clause is exact (`DigestResult.digest` is
non-nullable, so `companionDigest: null` with `has_description === true` can
only be a failure), and `mergeEntry`'s `??` wants "no value" regardless of why.

So `digestOnly` — the helper whose only job is to throw the discriminant away —
is deleted, and its single caller keeps the `GrimResult` it already gets from
`scopes.run`:

```
live.has_description !== true  → the artifact has no companion  → compare to cached null
probe.ok === false             → we learned nothing             → false, run the pipeline
probe.ok === true              → compare probe.value.digest to cached
```

`contentUnchanged`'s own signature is unchanged, so both of its callers
(`prefetchInto`, `revalidate`) need no edit.

**Why not thread the discriminant further.** Keeping `Result<Option<T>>` alive
through `resolveContent` into `entryFrom` (the research's Q1 recommendation)
would buy one more thing: `incompleteDocs` could stop inferring failure from
"null **and** advertised in `files[]`", a heuristic that misreads a doc whose
fetch *succeeded* but returned base64 (`fetchDoc` `:687` nulls those) as a
failed probe, pinning that repo to the short TTL permanently. That is a real but
narrow defect, invisible to the user, and closing it costs six helper signatures
and every one of their call sites. Recorded as the documented upgrade path with
a trigger: adopt it the first time `missed()` is observed misfiring, or the
first time a second reader needs per-field provenance.

**Why not per-field probe outcomes in the entry.** See the options table — the
owner rejected this earlier on diff size, and the digest establishes that diff
size is the *smaller* half of its cost. It changes the on-disk shape, which
forces a `CACHE_VERSION` bump, which drops every user's cache at once and sends
a full re-probe of the whole browse list at the registry on the first scroll
after upgrade — the exact storm H8 exists to prevent. Under the owner's
no-state-reset constraint it now has to clear a second bar as well, and it
cannot: the shape it needs is a per-field outcome that every reader consults, so
it cannot degrade safely as an absent optional field the way `complete` did. An
entry written before it would have no outcomes at all, and "no outcome recorded"
is precisely the ambiguity the option exists to remove — so it either purges the
old entries or reintroduces the defect for them.

## Decision 4 — negative caching is per repo; the registry-wide breaker is out of scope

`DetailsManager` gains an in-memory `Map<repo, failedAt>`, recorded at the two
sites where `entryFrom` returns null, cleared on any successful save and on
`forget(repo)`, and consulted by `isFresh` with the existing `RETRY_TTL_MS`
cooldown. No disk format change, no new constant.

The cooldown gates **only** `isFresh` — the background prefetch's skip filter.
A user opening a details panel always probes: a cooldown that silences a
user-initiated action is a bug, not a budget.

**What this does not close, stated as the research found it.** H8's own text
names a registry-wide 429. A per-key negative cache caps repeat probes of one
key; it does nothing about 100 distinct repos each firing their *first* probe at
an already-throttled origin. That is a circuit breaker's job — trip per origin,
not per key. **Recommendation: ship the per-repo map only.** Three reasons: the
extension has no evidence of a registry-wide 429 (the observed signal is "the
fetch returned nothing", cause unknown); origin derivation from a repo string is
not free here, because index/alias-backed rows resolve through a locator that is
not the ref prefix (see the search source-attribution work); and the trip/reset
policy would be a second untuned knob next to `CONCURRENCY = 10`, which itself
has no recorded floor. `CONCURRENCY` is today's only aggregate limiter and it
does bound the burst to ten in flight — the honest claim is "the storm is capped
at ten concurrent and no longer self-reinforcing", not "the 429 is fixed". The
code comment says exactly that, and names the breaker as the upgrade.

**No jitter on the cooldown.** The review's SOTA pass noted a flat retry TTL
wants jitter; this ADR declines it — but not for the reason the first draft gave.
That draft claimed the expiries are not synchronized. They largely **are**: a
single `visible` post enqueues the whole viewport at once, and `SEED_SWEEP`
(`sidebar.ts:659-662`) batches 24 more, so a batch that fails together expires
together. The decision stands on a different footing: the retry herd is no larger
than the burst that created it, and `CONCURRENCY` caps its edge either way — so
jitter would smooth a spike that is already bounded. Revisit together with the
breaker, whose reset would add a genuinely new synchronized edge.

## Options weighed

Criteria and weights: **Correctness** under a partly-failed probe (5) ·
**Reversibility / blast radius** (4) · **Cost to existing on-disk caches** (3) ·
**Diff and review surface** (2) · **Future per-field retry capability** (1).
Scores 1–5, max 75.

| Option | Corr. | Rev. | Cache | Diff | Future | **Total** |
| --- | --- | --- | --- | --- | --- | --- |
| **A. Merged entry is the paint; discriminant local** (this ADR) | 5 | 5 | 5 | 4 | 2 | **70** |
| C. `Result<Option<T>>` to the cache boundary, disk shape unchanged | 5 | 4 | 5 | 2 | 4 | **64** |
| D. Recompute `complete` from the merged entry (the RCA, literal) | 1 | 5 | 5 | 5 | 1 | **51** |
| B. Per-field probe outcomes in `DetailsCacheEntry` + version bump | 5 | 2 | 1 | 1 | 5 | **43** |

**A — recommended.** Discriminate the companion probe inside the one comparison
that reads a null as proof; `saveEntry` returns the merged entry; the paint and
the repost gate read it; `mergeEntry` keeps the settled guard; `complete` stays
probe-derived. Two files, no type change on disk, no bump. Every change is a
local edit that a later ADR can walk back without touching user data.
*Risk*: `incompleteDocs` remains a heuristic on the in-tree docs (see C).

**C — close second, deferred not rejected.** Strictly more correct, entirely
internal, and it is the shape the literature recommends. It loses on diff and
review surface *today*: six helpers and their call sites, to close one edge no
user has reported. Named as A's upgrade path with an explicit trigger.
*Risk of deferring*: a base64 README pins that repo to the 10-minute window
forever. Bounded, invisible, self-consistent.

**D — rejected.** Decision 2's counter-example: it converts a transient
vanishing into a permanent wrong. It is also the cheapest option, which is why
it needs writing down — the next reader will propose it again.

**B — rejected, and rejected by default under the owner's constraint.** Weighed
on its merits first: the capability it buys — retry only the field that failed,
and stop inferring failure at all — is genuinely the most correct of the four,
which is why it scores 5 on correctness and 5 on future capability. It loses on
everything else. The cost it imposes is a `CACHE_VERSION` bump, and that bump is
not a formality: every entry self-purges on load, so the first browse after
upgrade re-probes the entire viewport at once. Reversibility is the worst of the
four — an on-disk shape cannot be un-shipped, only bumped again. And the
capability has no requester today, so the whole price buys a possibility.

The constraint is what makes this decisive rather than a judgement call. B
cannot be built as an additive optional field: an absent per-field outcome is
itself ambiguous, so a legacy entry either gets purged (the state reset the
constraint forbids) or keeps the exact defect B was adopted to remove. If B is
ever genuinely needed, the honest sequencing is Option C first — it gets the
same information into the process without touching the disk — and B only if a
*second* reader turns up that needs the outcome to survive a window reload.

## Migration and rollout

**No `CACHE_VERSION` bump. It stays at 1.** No persisted-state migration of any
kind, and no `contributes.configuration` schema change. Option A adds no field
to `DetailsCacheEntry` at all, so the additive-and-optional allowance is not
spent here — it stays available for whatever needs it next.

- **Entries written by the released extension** carry no `complete` key. Every
  new read site gates on `complete === true`, so an absent key reads false:
  short TTL, one re-probe, then the entry settles as complete. This is exactly
  the behaviour the field's optionality was designed for and is unchanged by
  this ADR.
- **Entries with `artifactDigest: null`** never match `contentUnchanged` and
  always re-run the pipeline. Unchanged.
- **The one dirty case is branch-local.** The current H2 bug can stamp
  `complete: true` over content it never verified; such an entry survives the
  fix and short-circuits until the artifact digest moves. The branch has not
  landed, so only developer machines hold one. Deleting the cache directory (or
  any action that calls `forget`) clears it. Bumping `CACHE_VERSION` to purge a
  never-shipped defect would charge every user a full re-probe herd to fix a
  problem no user has — the trade runs the wrong way.
- **`mergeEntry`'s new guard needs no migration**: it reads `fresh.complete`,
  and `fresh` is always an entry this process just built.

## Explicitly not being fixed

1. **The registry-wide 429.** Decision 4. Per-repo cooldown ships; the
   per-origin breaker does not. Residual stated in the ADR and in the code.
2. **Cooldown jitter.** Decision 4.
3. **`incompleteDocs`'s in-tree heuristic** (a base64 doc reads as a failed
   probe). Option C, deferred with a trigger.
4. **`cachedSnapshot()` staleness** (digest §C.8): nothing watches materialized
   artifact outputs, so the modified-artifact list a refusal dialog names can be
   empty exactly when grim's refusal is correct. The dialog degrades to its
   unnamed form, which is why that form exists. Fixing it means watching output
   files — a different subsystem and a different plan.
5. **The settings surface's action vocabulary.** `src/webview/settings/render.ts`
   carries 19 further `data-action` literals and gates on `vm.busy` rather than a
   mutating set. C-019's drift test scans `src/webview/render.ts` only, so the
   settings surface is outside its reach in either direction. Recorded so the next
   reader does not assume the sweep is repo-wide.
5. **The dual action vocabulary** (kebab `data-action` vs camelCase message
   `type`). The guard tables are made exhaustive and drift-tested; the two
   vocabularies are not unified. Unifying them is a rename across every template
   and both host routers for no behaviour change.
6. **`src/webview/brokenImage.ts`** placing DOM code in a directory `CLAUDE.md`
   declares DOM-free. Pre-existing, out of scope, deliberately not entrenched:
   the new pure module this work adds (`src/webview/actions.ts`) is DOM-free and
   vscode-free, so it sets the right precedent rather than the wrong one.

## Recorded-boundary check (`CLAUDE.md`, `.claude/rules/*`)

| Boundary | Status |
| --- | --- |
| `src/grim.ts` is the only spawn point | Held. `contentUnchanged` calls `scopes.run` with the existing `fetchArgs` builder; no new argv shape, no new spawn site. |
| grim JSON is frozen/additive; nullable means null | Held. No new field is assumed. `forceable` keeps its `=== true` read (`isForceable`). |
| `src/scopes.ts` owns scope flags | Held. Every call still passes a `Scope`; no builder learns a flag. |
| `src/webview/` stays pure (no vscode, no DOM) | Held **and improved**: the two `MUTATING_ACTIONS` tables move out of the browser entries into a pure `src/webview/actions.ts`, which is what makes them testable at all. |
| lit-html always; goldens are frozen parity fixtures | Held. Nothing in this ADR changes rendered output. **A moved golden in this work is a signal that something went wrong.** |
| No new runtime dependency | Held. |
| No breaking change to persisted state (owner constraint) | Held. `CACHE_VERSION` stays 1, no field added or removed, no field's meaning changed. Legacy entries keep reading exactly as they do today. |
| No breaking change to `contributes.configuration` (owner constraint) | Held. The only `package.json` edit in this repair is the `grimoire.prefetchDetails` **description** string (digest §A.6 — it still says "top Browse results", which the viewport-following sweep made false). Setting ID, type and default are untouched, and a description is not schema. |
| No pre-1.0 compat shims / no `grim-polyfill<` marker | Held. Nothing here is CLI-surface compatibility. |
| `CHANGELOG.md` is generated | Held. Wording goes in the commit subjects. |

**Deviation recorded — one.** This ADR keeps `artifactDigest: null` as a
sentinel meaning "the content here is not pinned to a verifiable digest", which
is a null carrying two meanings — the very pattern the review's RCA names. It is
kept knowingly: it is a *single* documented sentinel, written at one site
(`entryFrom`) and read at two (`contentUnchanged`, `isFresh`'s companion in
Decision 2), and every alternative encoding costs an on-disk shape change. The
field doc is amended to say so in one sentence, so the next reader meets the
decision instead of re-deriving it. If a third reader ever appears, adopt
Option C.

## Consequences

- An open details panel and the browse card behind it can no longer disagree
  with the cache: all three paint the merged entry.
- A partly-failed probe is visible in exactly one way — a shorter retry window —
  and never in a worse paint.
- Content a publisher actually deletes now disappears on the next probe, because
  a complete fresh entry replaces the cached one wholesale.
- A repo whose probe fails outright is retried once per `RETRY_TTL_MS` instead
  of once per viewport report, and the failing burst stays capped at
  `CONCURRENCY`.
- `complete: true` becomes a claim the code can defend: it is only ever written
  behind a probe or a digest match, never behind a merge.
- The design is reversible field-by-field. Nothing here changes the on-disk
  shape, so a later ADR can adopt Option C or B without a migration of its own.
