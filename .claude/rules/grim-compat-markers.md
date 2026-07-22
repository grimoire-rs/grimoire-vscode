---
paths:
  - "src/**/*.ts"
---

# grim compatibility markers

Standing policy is **no pre-1.0 compat shims**: target the current grim, let a
stale binary surface its real error. This rule is not a licence to add them — it
is the price of the rare one that is explicitly approved, so it expires on
schedule instead of rotting into permanent code nobody dares delete.

## Syntax

One line, directly above the branch it guards:

```ts
// grim-polyfill<X.Y.Z: <what an older grim does at the CLI level, and why this branch exists>
```

`X.Y.Z` is the first grim release where the branch is **dead**. Delete the branch
when `MINIMUM_GRIM_VERSION` (`src/installer.ts`) reaches `X.Y.Z`.

Find every marker:

```sh
grep -rn 'grim-polyfill<' src --include='*.ts'
```

## When to use it

Only for **CLI-surface** compatibility — a difference at the process boundary
that cannot be detected from the payload:

- a flag or subcommand an older grim rejects with exit 64 (clap usage error)
- a behavioral difference in exit codes or stream handling

## When NOT to use it

**Never on additive or nullable JSON-field handling.** "grim's JSON interface is
frozen/additive — never assume a field exists; nullable means null" (CLAUDE.md)
is permanent doctrine, not a shim. It does not expire, and marking it would queue
correct code for deletion at every floor bump.

The distinction has already been got wrong once: `error.forceable` is an additive
field, was already handled correctly by a strict `=== true` check
(`src/grim.ts`, `isForceable`), and still got a hard `MINIMUM_GRIM_VERSION` bump
on top — which briefly pinned the floor to a grim release that did not exist yet.
An absent field needs a read-site guard, never a version gate.

Also never mark `MINIMUM_GRIM_VERSION` or `grimTooOld` themselves. They are the
floor, not an instance of compatibility with something below it.

## Before tagging one

Confirm the branch is reachable **only** on a pre-floor grim — that every caller
has already passed the `grimTooOld` gate in `ScopeService.scopeSnapshot`. The
gate flags a too-old binary in the snapshot; it does not block later commands, so
"unreachable below the floor" is not automatic. If some caller bypasses it,
"safe to delete at X.Y.Z" is false and the marker lies.

## Don't land it empty

The marker ships in the same commit as the first real degradation branch, never
speculatively — and so does its enforcement. A marker with no paired degradation
logic is the signal that it is being used prematurely.

When the first marker lands, add the expiry check with it: one test that scans
`src/**/*.ts` for `/grim-polyfill<(\d+\.\d+\.\d+):/g`, fails when
`!isNewerVersion(marker, MINIMUM_GRIM_VERSION)` (reuse the comparator already in
`src/installer.ts` — no new dependency), and also fails on any literal
`grim-polyfill<` that does not match the strict three-component pattern, so a
typo cannot exempt itself from the sweep.
