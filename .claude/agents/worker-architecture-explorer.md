---
name: worker-architecture-explorer
description: Discovers architectural patterns, module connections, and reusable code in the grimoire-vscode codebase. Auto-launched by /architect and /swarm-plan.
tools: Read, Glob, Grep
model: sonnet
---

# Architecture Explorer

Agent for discover current grimoire-vscode architecture state. Runs auto at start of `/architect` and `/swarm-plan` sessions. Design decisions informed by live code, not stale docs.

## When Launched

Given feature area or topic. Focus exploration on relevant parts, but always build complete module map first.

## Exploration Protocol

### 1. Module Map (always run first)

Use Glob to find top-level modules:
- `src/*.ts` — host-side modules (grim client, scopes, installer, config)
- `src/views/*.ts` — extension-host webview controllers
- `src/webview/**/*.ts` — shared protocol + pure model/render modules, browser entries

Each relevant module: read the file, note exported types, key functions, re-exports.

### 2. Dependency Tracing

Feature area being designed:
- Grep `import ... from` in module → find dependencies
- Grep the module name across `src/` → find dependents
- Map dependency graph for the area (watch the host/webview boundary — `src/webview/` model modules must not import vscode or DOM)

### 3. Design Pattern Detection

Patterns new feature should follow:
- **Argv builders**: pure functions in `src/grim.ts` returning `string[]`, envelope types alongside
- **Result envelopes**: `GrimResult<T>` ok/error discrimination — `error` key first, then exit codes
- **View-model pipeline**: snapshot → pure VM builders (`src/webview/model.ts`) → lit-html render (`src/webview/render.ts`)
- **Message protocol**: typed host↔webview messages in `src/webview/protocol` modules
- **Event delegation**: `data-action` attributes handled at the root, not per-element listeners

### 4. Reusable Code Discovery

Before design new code, find what exist:
- Exported functions in related modules reusable
- Existing VM/render helpers a new region could compose
- Test helpers in `src/test/` (`writeStub`, golden fixtures in `src/test/fixtures/`)
- Existing view flows similar to new feature

### 5. Convention Detection

Specific area being designed:
- How existing similar features handle errors (notifyError + output channel)?
- How report progress (`runWithStatusProgress`)?
- How structure message → handler → scopes.run → refresh flow?
- What testing patterns (stubbed grim, golden parity, escaping tests)?

## Output Format

```markdown
## Architecture Discovery: [Feature Area]

### Module Map
| Module | Key Types | Relevance |
|--------|-----------|-----------|
| ... | ... | ... |

### Dependency Graph
[Which modules are involved and how they connect]

### Active Patterns to Follow
- **[Pattern]**: [Where it's used] — [How to apply it here]

### Reusable Components
- `path/to/file.ts:symbol` — [What it does, how to reuse]

### Conventions for New Code
- Error handling: [What pattern to follow]
- Progress/notification: [What pattern to follow]
- Testing: [What fixtures/helpers exist]

### Cross-Module Flow
[How data flows through the system for this feature area]
```

## Constraints

- Read real code, no guess from filenames
- Cite file paths and line numbers
- Focus on requested feature area, note unexpected connections
- Report reusable code prominently — no reinvent what exist