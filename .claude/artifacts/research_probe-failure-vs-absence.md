# Research — carrying "failed" apart from "absent" through a content cache

Axis: design patterns. Produced during `/hex-plan medium` for the repair of the
`/hex-review high` findings on `feat/cache-freshness-and-outputs-pending`
(2026-08-12). Scoped deliberately to the four questions the review's own SOTA
pass left open — that pass returned **pass** and already settled: capture-phase
`error` handling, `color-mix` on the `^1.96.0` engine floor, `loading="lazy"`
non-applicability, IntersectionObserver initial-callback timing, and that a flat
retry TTL wants jitter.

## Q1 — nesting order for absent vs failed

**`Result<Option<T>, E>`, not `Option<Result<T, E>>`.** "Operation succeeded,
found nothing" is `Ok(None)`; `Err` is reserved for "the operation itself
failed". This is the DB-driver convention (`.optional()` / first-or-none helpers
returning `QueryResult<Option<T>>`). The other order forces "did we even try?"
ahead of "did it work?", which is backwards for a cache read.

Mature client caches never collapse this into one nullable field. TanStack Query
and SWR keep `data` and `error` as **independent channels** — `data` holds the
last good value while `error`/`isError` describes the current attempt, so "stale
data + failed refetch" stays distinct from "the server says empty". Apollo's
`errorPolicy: 'all'` does the same. HTTP models it too: `stale-if-error`
(RFC 5861) is a distinct directive from a legitimate empty/404.

TS shape: keep the discriminated union (`{ok:true; value:T|null} | {ok:false;
error}`) alive to the point the cache entry is written, rather than unwrapping to
`T | null` at the first helper.

**APPLIES.** `GrimResult<T>` → `T | null` at the first helper is exactly the
anti-pattern these conventions exist to prevent.

Sources: users.rust-lang.org "how to deal with nested results/options";
honestlysam.uk nested-options-in-rust; TanStack Query v4 useQuery reference and
discussion #3623; RFC 5861.

## Q2 — negative caching shape

A per-repo `Map<repo, failedAt>` with a cooldown is legitimate and established
(negative caching, cf. DNS negative caching, RFC 2308): cache the *fact* of
failure with a TTL so repeat lookups of the same key short-circuit.

**But it does not close the threat H8 names.** The stated failure mode is a
registry-wide 429. A per-key negative cache caps repeat probes of one key; it
does nothing to cap aggregate rate against a struggling origin — 100 distinct
repos scrolling into view each get their own cooldown and each still fires its
*first* probe at the already-throttled registry. That is the circuit breaker's
job: breakers trip per protected remote dependency, not per key, so many keys
against one failing service collapse into a single open state.

`stale-if-error` does not apply to H8 as written: nothing was ever cached on the
failure path (`entryFrom` returns null, nothing is written), so there is no stale
copy to serve. That gap is Q1's problem, not Q2's.

**PARTIALLY APPLIES.** Ship the per-repo map — correct, cheap, stops re-hammering
one key. Do **not** describe it as closing the 429 storm; that needs a second,
per-origin breaker (derive the registry host from the repo, trip after N failures
in a window, short-circuit while open). If only the per-repo map lands, say so.

Sources: RFC 2308; circuit-breaker/API-resilience overviews (zuplo learning
center; rate-limiting vs circuit-breaker comparison).

## Q3 — trailing-edge debounce vs leading-guard throttle

Confirmed. `clearTimeout` + reschedule on every call is the standard trailing-edge
debounce for "report once the user stops scrolling". `if (timer) return` is a
leading-edge fire-then-ignore throttle. Lodash's default (`trailing: true`) resets
the timer on every invocation and fires only after the quiet period.

```ts
let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleVisiblePost(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    postVisible();            // read shared state HERE — required, not a bug
  }, 300);
}
```

Reading the shared mutable Set **at fire time is correct and required** — the
point is to act on the latest state once things settle; snapshotting at schedule
time reproduces the current bug. The pitfall to guard instead is a timer firing
after teardown: clear it on disconnect, not only on reschedule.

**APPLIES.** No dependency needed; the project forbids adding one for this.

Sources: CSS-Tricks debouncing/throttling explained; lodash `debounce` docs.

## Q4 — exhaustive union-derived guard sets

`Record<Union['type'], boolean>` is idiomatic: a mapped type requires every key,
so a new union member with no entry is a compile error at the literal. Refine
with **`satisfies`** (TS 4.9+), which keeps the object's inferred literal-key type
instead of widening to `Record<string, …>`:

```ts
const MUTATING = { … } satisfies Record<Action['type'], boolean>;
```

Alternatives weighed: const-object-plus-`keyof` derives a union *from* an object
(inverse direction — useful only if the DOM vocabulary is generated too);
`switch` + `assertNever` is idiomatic when each case needs distinct logic, but is
more ceremony than a flat boolean table; template-literal camelCase→kebab
derivation is possible (TS 4.1+) but fragile on acronym/digit edges and only
checks string *shape*, not that the derived name is the one actually wired to the
template's `data-action` — a manual mapping object is more boring and more
correct ("choose boring technology").

Because the real defect is the **dual vocabulary** (kebab `data-action` vs
camelCase message `type`), the shape that closes the root cause rather than the
symptom derives both from one source:

```ts
const ACTION_MAP = {
  install: 'install',
  completeInstall: 'complete-install',
  pickVersion: 'pick-version',
} as const;
type MessageType = keyof typeof ACTION_MAP;
type DataAction  = (typeof ACTION_MAP)[MessageType];

const MUTATING_ACTIONS = {
  install: true,
  completeInstall: true,
  pickVersion: false,
} satisfies Record<MessageType, boolean>;
```

**APPLIES.** Least-ceremony compile-checked shape for H3; pair it with the single
camelCase→kebab source object to close root cause #2 rather than only H3.

Sources: TS `satisfies` operator write-ups; microsoft/TypeScript#53171 on
exhaustiveness checking.
