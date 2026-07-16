---
paths:
  - ".claude/skills/**"
  - ".claude/state/**"
---

# Plan Status Protocol

Every plan in `.claude/state/plans/plan_*.md` carries a `## Status` block at the top — first 30 lines after H1 — so the user (and any skill) can read current state at a glance without scanning the full plan.

## Schema

```markdown
## Status

- **Plan:** plan_<slug>
- **Active phase:** <N> — <phase title>
- **Step:** <skill or activity, e.g. /swarm-execute → implementation>
- **Last update:** <YYYY-MM-DD> (after <commit-sha-short>: <subject>)
```

Allowed `Step` values:
- `/swarm-plan → plan-approved`
- `/swarm-execute → <stage>` (Stub, Specify, Implement, Review-Fix Loop)
- `/swarm-review → round N`
- `awaiting /swarm-review`
- `awaiting /swarm-execute (review-fix loop)`
- `awaiting /finalize`
- `finalized` (terminal — `/finalize` writes this then deletes `current_plan.md`)

## Global pointer

`.claude/state/current_plan.md` (gitignored):

```markdown
# Current Plan Pointer

- **Plan:** .claude/state/plans/plan_<slug>.md
- **Branch:** <branch-name>
- **Updated:** <YYYY-MM-DD HH:MM UTC>
```

## Per-skill mutation table

| Skill | Reads | Writes |
|---|---|---|
| `/swarm-plan` | — | Init Status in new plan; write `current_plan.md` |
| `/swarm-execute` | Status | Flip `Step` on phase entry/advance; bump `Last update` |
| `/swarm-review` | Status | Flip `Step` on round entry; set `awaiting /finalize` or `awaiting /swarm-execute` on verdict |
| `/finalize` | Status | **Refuse if Step ≠ `finalized` and `Active phase` not last** (`--force` overrides); on success set `Step: finalized`, delete `current_plan.md` |

Phase advancement (`Active phase: N → N+1`) is the orchestrator/plan-author decision encoded as a Step transition — never an automatic side-effect of commits.

## Why both files

- `current_plan.md` is the **fast path** (read one small file, jump to the referenced plan).
- The Status block in the plan file is the **truth** (survives `current_plan.md` deletion, captures plan-internal phase progression).
- Together: `current_plan.md` answers "which plan?", the Status block answers "where in that plan?". Either alone is incomplete.

## Subplans (parent-stack)

A plan may spawn a subplan (e.g. a high-tier review opens its own `plan_review_*.md`). The Status schema supports nesting via an optional `**Parent plan:**` field:

```markdown
## Status

- **Plan:** plan_review_X
- **Parent plan:** plan_feature_y (resume after Step: finalized)
- **Active phase:** 1 — Findings triage
- **Step:** /swarm-review → round 1
- **Last update:** 2026-07-16 (after 9c2b4c9: ...)
```

Protocol:

1. **Spawn**: the skill creating a subplan (a) writes the new plan with `Parent plan:` set to the current `current_plan.md` target, (b) repoints `current_plan.md` to the subplan. The parent's Status block is untouched.
2. **Run**: standard mutation rules apply to the subplan only.
3. **Return**: when the subplan reaches `Step: finalized`, `/finalize` checks `Parent plan:`. If present, it repoints `current_plan.md` back to the parent and bumps the parent's `Last update` instead of deleting the pointer.
4. **Stack depth**: implicit via the chain of `Parent plan:` fields — no explicit stack file.
