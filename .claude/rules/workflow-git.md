# Git & Commit Workflow

Shared branch-and-commit hygiene. Used by the `/finalize` skill (rebasing phase).

## Ground rules

- **Never commit on `main`.** If on `main`, stop and switch to a feature branch first.
- **Never push.** Push triggers CI and publishes history — the human decides when. No skill, agent, or automation pushes on its own.
- **Never `--no-verify`, `--no-gpg-sign`, or any hook-skipping flag.** Hook fail → fix root cause, new commit.
- **Never `Co-Authored-By`** in commit messages.

## Two-Phase Model

Branch commit history goes through two phases:

| Phase | Goal | Rule |
|---|---|---|
| **Working** (default on feature branches) | Save progress while iterating. Bundle freely. Amend rolling Checkpoints. | One concern per commit **relaxed**. Honest bundle message better than fake narrative. |
| **Rebasing** (explicit, before landing — `/finalize`) | Produce the exact commits that appear in the changelog | Strict Conventional Commits v1.0.0. One concern per commit. Reword/squash/split as needed. |

## Checkpoint Convention

A commit with subject exactly `Checkpoint` (no type, no body) means "rolling WIP". Amended every time new work lands on top. Never goes to `main`. `/finalize` refuses to land a branch that still contains one. `task checkpoint` creates or amends it.

## Conventional Commits (Quick Rules)

- Format: `<type>[optional scope]: <description>`
- Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`
- **`chore(claude):`** for AI/tooling files (`.claude/`, `CLAUDE.md`, taskfiles) — keeps them out of the user-facing changelog
- Imperative mood, lowercase description, no trailing period, subject ≤72 chars
- Body explains **why**, not what. Only when non-obvious.
- Breaking changes: `!` before the colon **and** a `BREAKING CHANGE:` footer

## Land-Ready Definition

A branch is ready to fast-forward onto `main` (`task git:merge`) when **all** hold:

- [ ] Rebased on top of current `main` (no merge commits in `main..HEAD`)
- [ ] Every commit in `main..HEAD` has a Conventional Commits subject
- [ ] No `Checkpoint` commits remain
- [ ] No "bundle" commits mixing unrelated concerns
- [ ] `task verify` passes on the final state

`/finalize` checks each and proposes a rebase plan for anything that fails.
