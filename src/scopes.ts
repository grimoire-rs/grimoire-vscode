// Scope discovery and per-scope grim invocation. Project scope exists when a
// workspace folder is open; it is *configured* when grim reports
// config_exists (grimoire.toml found by walk-up discovery from the folder).
// Global scope always exists ($GRIM_HOME, default ~/.grimoire).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readConfig, DEFAULT_EXECUTABLE } from './config';
import { grimTooOld, tooOldMessage } from './installer';
import { declaredKey } from './webview/model';
import {
  contextArgs,
  statusArgs,
  runJson,
  type ContextInfo,
  type GrimResult,
  type RunOptions,
  type Scope,
  type StatusEnvelope,
  type StatusItem,
} from './grim';

export interface ScopeSnapshot {
  context: ContextInfo;
  /** The scope's installed artifacts, or `null` when install state could NOT be
   *  determined (see `statusUnknownReason`). The two are different claims and
   *  must render differently: `[]` is the positive "nothing is installed here",
   *  `null` is "we don't know" — rendering `null` as `[]` flips every installed
   *  card to Install and makes the details panel claim an artifact is absent
   *  from a scope it may well be installed in. Every reader has to decide;
   *  that is why this is `| null` rather than a sibling flag.
   *
   *  Not uniformly this round's data: the three `--check`-only fields
   *  (`update_available`/`deprecated`/`replaced_by`) on each row may be
   *  REMEMBERED from an earlier checked round rather than what grim just said —
   *  a plain `grim status` leaves them null and {@link mergeCheckedFields} fills
   *  them from the last check. Every other field is this round's. */
  status: StatusItem[] | null;
  /** Why `status` is null. `'too-old'`: the binary is below the version floor,
   *  so `grim status` was never run. `'status-failed'`: the status call ran and
   *  failed. The control signal for the render layer's choice of action — the
   *  human-readable `statusError` string stays display text and must not be
   *  pattern-matched. Absent exactly when `status !== null`. */
  statusUnknownReason?: 'too-old' | 'status-failed';
  /** name -> declared reference (with tag) from grimoire.toml */
  declared: Record<string, string>;
}

export interface Snapshot {
  project?: ScopeSnapshot;
  global?: ScopeSnapshot;
  projectFolder?: string;
  grimMissing: boolean;
  error?: string;
  /** Set when a workspace folder is open and the project-scope `grim context`
   *  probe failed for a reason OTHER than the ordinary "no grimoire.toml"
   *  outcome (see `isProjectNotDiscovered`) — a genuine transient error
   *  (permissions, I/O, malformed config). `project` is `undefined` in both
   *  that case and the merely-unconfigured case, so without this flag a
   *  genuine failure reads as "unconfigured" downstream — silently flipping
   *  browse/search to the global registry set instead of surfacing the probe
   *  failure. The ordinary no-toml outcome must NOT set this flag: it needs
   *  to read exactly like "unconfigured" so the global fallback and the
   *  init-offer notice both fire. See projectSearchable(). */
  projectProbeFailed?: boolean;
  /** Set when the global-scope `grim context` probe failed with an error (not
   *  the not-found case, which becomes `grimMissing`). `global` is `undefined`
   *  then, so — like `projectProbeFailed` — this flag is what lets the render
   *  funnel synthesize a `status: null` global scope (`scopeStatuses`) instead
   *  of silently dropping it; without it a genuinely unreadable global reads as
   *  "nothing installed globally". Set beside `error` in snapshot(). */
  globalProbeFailed?: boolean;
}

/** Parses a grimoire.toml's declarations into {@link declaredKey} -> ref pairs.
 *  Pure; exported for tests. */
export function parseDeclaredRefs(toml: string): Record<string, string> {
  // ponytail: hand-rolled line parser instead of a TOML dep at runtime — the
  // config format is flat `[section]` tables of `name = "ref"` pairs.
  const declared: Record<string, string> = {};
  // Table -> the kind grim reports for its rows, so the entry is keyed by
  // (kind, name) like grim's own identity. Keyed by name alone, a name declared
  // in two tables (a `code-review` skill AND agent) gave both status rows the
  // same ref — one artifact then wore the other's repo. `[mcp]` is the one
  // table whose name is already the kind.
  const kinds = new Map([
    ['skills', 'skill'],
    ['rules', 'rule'],
    ['agents', 'agent'],
    ['bundles', 'bundle'],
    ['mcp', 'mcp'],
  ]);
  let kind: string | undefined;
  for (const rawLine of toml.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      kind = kinds.get(line.replace(/[[\]]/g, '').trim());
      continue;
    }
    if (kind === undefined || line.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z0-9._-]+)\s*=\s*"([^"]+)"/.exec(line);
    if (match && match[1] && match[2]) {
      declared[declaredKey(kind, match[1])] = match[2];
    }
  }
  return declared;
}

/** Absolute path of the first `grim` executable on PATH, or undefined. Used to
 *  keep the extension-managed copy (globalStorage/bin) a pure FALLBACK: a
 *  user-managed grim on PATH always wins — preferring the bundled copy
 *  shadowed a current PATH grim with a stale one (the silent `status --check`
 *  failure). The path (not just a boolean) also names the actual binary in the
 *  version-floor message: "grim 0.9.1 at grim is too old" answers nothing when
 *  the whole question is WHICH grim the host's PATH resolved. Scans PATH
 *  directly instead of spawning `which`/`where`; early-returns on the first
 *  hit, so the full scan (slow /mnt/c entries under WSL included) only runs in
 *  the no-grim-anywhere state. Pure over `env`; exported for tests. */
export function whichGrim(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts =
    process.platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      try {
        // RESOLVED, not merely joined: a relative PATH entry (`.`, `bin`,
        // `./tools` — all legal) would otherwise yield a relative executable
        // path, which run() then resolves against ITS cwd, the workspace
        // folder. That is the same threat as handing the OS a bare `grim`: a
        // repository shipping its own grim would win. Resolving before the
        // access check also keeps the file we probed and the file we return the
        // same one.
        const candidate = path.resolve(dir, `grim${ext}`);
        fs.accessSync(candidate, fs.constants.X_OK);
        // X_OK passes on directories too — a dir named `grim` on PATH is not
        // an executable.
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // not here — keep scanning
      }
    }
  }
  return undefined;
}

/** Prepends the top-level `--global` flag before the subcommand. grim documents
 *  `--global` as a global option ("Operate on the global scope rather than the
 *  discovered project"); placing it before the subcommand is the canonical
 *  position and, unlike a trailing flag, can never land after a builder's `--`
 *  positional separator (where clap rejects it as an unexpected argument).
 *  Pure; exported for tests. */
export function withGlobalFlag(args: string[]): string[] {
  return ['--global', ...args];
}

/** True when a failed project-scope `grim context` probe failed for the
 *  ORDINARY reason — no grimoire.toml exists anywhere up the directory tree
 *  from the workspace folder. grim reports this as an error envelope, not a
 *  success with `config_exists: false`: `ProjectConfig::discover_from`'s
 *  walk-up itself fails with `NotDiscovered` (code "not-found", exit 79) when
 *  it finds nothing, so `context` (which requires discovery to succeed before
 *  it can report anything) never reaches the point of emitting
 *  `config_exists: false` — verified against grim 0.9.0. grimoire-vscode
 *  never passes `--config`, so this is the only way `context` fails with this
 *  code for project scope; a genuine transient failure (permissions, I/O,
 *  malformed config) always carries a different code. Structural detection
 *  off the error code — never string-matches grim's message text. (grim
 *  also tags this same failure with `reason: "no-config"`; the `code`
 *  check below is kept as the discriminator regardless — the two are set
 *  together for this exact case, so swapping to `reason` would be pure
 *  churn with no behavior change.) Pure; exported for tests. */
export function isProjectNotDiscovered(probe: GrimResult<ContextInfo>): boolean {
  return !probe.ok && probe.kind === 'error' && probe.code === 'not-found';
}

/** Collapses project scope's tri-state — configured, unconfigured, or probe
 *  failed — into whether project scope is what a browse/search should target.
 *  `config_exists` alone can't tell "no grimoire.toml" apart from "the probe
 *  errored", since both leave `snapshot.project` undefined; treating a
 *  GENUINELY failed probe (see `isProjectNotDiscovered`) as searchable keeps
 *  browse on project scope so the failure surfaces as a search error, rather
 *  than silently falling back to global's registry set. The ordinary
 *  "no grimoire.toml" outcome is deliberately NOT flagged as a probe failure
 *  (see `projectProbeFailed`'s doc comment) — it reads as plain unconfigured
 *  here, which is what drives the global fallback. Pure; exported for tests. */
export function projectSearchable(snapshot: Snapshot): boolean {
  return (
    (snapshot.project?.context.config_exists ?? false) || (snapshot.projectProbeFailed ?? false)
  );
}

/** The scope a browse/search actually targets: project only when a folder is
 *  open AND it is searchable (see projectSearchable), else global — an
 *  unconfigured project has no registries and would search nothing. One
 *  source: CatalogService.search picks the scope with it, and the Settings
 *  panel's "Browse searches <scope>" notice reads the same call. The notice
 *  used to hand-copy the rule, and a notice that lies about where Browse looks
 *  is worse than no notice. Pure; exported for tests. */
export function searchScopeFor(projectFolder: string | undefined, searchable: boolean): Scope {
  return projectFolder !== undefined && searchable ? 'project' : 'global';
}

/** The three fields `grim status` only populates under `--check`, remembered
 *  per artifact pin between checks. */
export interface CheckedFields {
  update_available: boolean | null;
  deprecated: string | null;
  replaced_by: string | null;
}

/** One remembered-verdict record per scope. Key-free on purpose: the key names
 *  AND which storage each scope lands in (project → workspaceState, global →
 *  globalState) are composition-root decisions and live in extension.ts. The
 *  earlier key/value face was a strict subset of `vscode.Memento` (no `keys()`),
 *  but a key-addressable one over the SAME store — so it still reached the rest
 *  of the extension's persisted state, and it pinned every scope to whichever
 *  single Memento was handed in: two open workspaces then pruned each other's
 *  project record away.
 *
 *  Required of every implementation: once a `write` for a scope has RESOLVED,
 *  the next `read` of that scope must observe it. `rememberChecks` serializes
 *  read → merge → write per scope and awaits the write, and that guarantee is
 *  the whole reason the serialization works — it relies on nothing more, so a
 *  store whose write lands asynchronously (a real disk-backed one) is fine.
 *  `read` is deliberately synchronous and total: it answers `{}` for a scope
 *  nothing was ever written for, never a rejection. */
export interface CheckStore {
  read(scope: Scope): Record<string, CheckedFields>;
  write(scope: Scope, record: Record<string, CheckedFields>): Promise<void>;
}

/** Session-lifetime CheckStore. The default, so tests and any construction
 *  without an ExtensionContext behave — verdicts then simply don't outlive the
 *  window. */
export function memoryCheckStore(): CheckStore {
  const records = new Map<Scope, Record<string, CheckedFields>>();
  return {
    read(scope: Scope): Record<string, CheckedFields> {
      return records.get(scope) ?? {};
    },
    write(scope: Scope, record: Record<string, CheckedFields>): Promise<void> {
      records.set(scope, record);
      return Promise.resolve();
    },
  };
}

/** Cache key for one status row's remembered check verdict. The PIN is part of
 *  the key, which is the whole invalidation strategy: updating or re-locking an
 *  artifact re-pins it, so the old verdict is simply never looked up again. No
 *  TTL, and nothing to clear when `grim update` runs behind our back. */
function checkKey(item: Pick<StatusItem, 'kind' | 'name' | 'pinned'>): string {
  // '|' BRACKETS the name rather than merely separating three fields, and that
  // is the whole argument: `kind` is a fixed lowercase word and `pinned` is a
  // full OCI reference, neither of which can contain a '|', so the first and the
  // last '|' delimit `name` unambiguously however it is spelled. Deliberately
  // NOT a charset claim about the name itself — grim's own name grammar has no
  // underscore, and bundle and MCP names are not charset-validated at all, so
  // two of the five kinds are simply not guaranteed to be OCI path segments.
  // Two distinct rows still cannot collide on one key.
  return [item.kind, item.name, item.pinned ?? ''].join('|');
}

/** Merges a status round with the last-remembered `--check` verdicts, and
 *  returns both the merged items and the record to persist.
 *
 *  grim leaves `update_available`/`deprecated`/`replaced_by` null on a plain
 *  `grim status` (no `--check` ⇒ no network). Without this, every watcher
 *  event, config change and post-action refresh recomputed the update count
 *  from the local lock proxy (`outdated`/`stale` — "installed digest ≠ lock",
 *  NOT "the registry has something newer"), so the badge flipped between two
 *  different meanings all day.
 *
 *  The three fields do NOT share one rule, because their nulls do not mean the
 *  same thing:
 *
 *  - `update_available` is tri-state, so a fresh `false` is an answer and wins
 *    (`??` only falls back on null/undefined): a check that says "no update"
 *    clears a remembered `true`, while a per-artifact re-resolution that FAILED
 *    under `checked: true` reads as null and keeps the last good verdict rather
 *    than flip-flopping. The MEMORY steps aside on a row grim reports as
 *    `outdated`/`stale`: that is a config-vs-lock question, and a registry
 *    verdict cannot answer it at any age. The merged value is null there, so
 *    `computeUpdateAvailable` falls back to the local proxy — which is how this
 *    path behaved before any of it was remembered. The rule is not special-cased
 *    to a remembered `false`: a remembered `true` reaches the same displayed
 *    outcome through the proxy, so stepping aside for both costs nothing.
 *    Stepping aside is a DISPLAY rule only — the record still keeps the last
 *    registry verdict. It has to: grim derives `stale` from the scope's
 *    `declaration_hash`, which is scope-wide, so a single grimoire.toml edit
 *    marks every row in that scope stale at once, and remembering the
 *    drift-induced null would erase the whole scope's memory until the next
 *    daily check. Resolving the drift does not save it either — an `outdated`
 *    row's remediation moves the RECORDED pin, not the lock pin the key is built
 *    from, and simply reverting the toml edit clears `stale` with the lock
 *    untouched. So the key (see {@link checkKey}) is not an escape hatch here.
 *  - `deprecated`/`replaced_by` are two-state: null encodes "not deprecated" and
 *    "did not look" identically, and `checked` narrows that only partly. Under
 *    `checked: true` grim did go online, but its null is still ambiguous — grim
 *    degrades a failing registry per-row and keeps reporting `checked: true`
 *    (commands.md), so a null means EITHER "upstream cleared the notice" OR
 *    "this row's registry was unreachable". Taking it verbatim is a choice
 *    between two wrong answers rather than a definitive clear, and it is NOT
 *    self-limiting: the clear is persisted, so a registry that stays unreachable
 *    keeps its rows' notices cleared for as long as it is down. It is still the
 *    better trade — a stale `replaced_by` drives a Switch install at a target
 *    the publisher has moved on from, while a missing notice only fails to offer
 *    one, and the alternative pins a deprecation on an artifact forever past the
 *    day upstream un-deprecates it.
 *
 *  Only keys seen this round are written back, so the record self-prunes to the
 *  installed set.
 *
 *  Pure over its inputs; exported for tests. */
export function mergeCheckedFields(
  items: StatusItem[],
  remembered: Record<string, CheckedFields>,
  /** This round's `envelope.checked` — true when grim actually re-resolved
   *  online, which is what makes a null `deprecated`/`replaced_by` a clear
   *  rather than "didn't look". */
  checked: boolean,
): { items: StatusItem[]; remember: Record<string, CheckedFields> } {
  const remember: Record<string, CheckedFields> = {};
  const merged = items.map((item) => {
    const key = checkKey(item);
    const previous = remembered[key];
    // The registry's last word on this row, fresh or remembered — what gets
    // PERSISTED, drift or no drift.
    const carried = item.update_available ?? previous?.update_available ?? null;
    // Local drift the lock itself reports — the local proxy already answers
    // "update available" for it, so the row DISPLAYS null and lets that proxy
    // speak rather than a remembered "no update" from before the drift.
    //
    // `stale` is deliberately NOT drift here, and this is the half that makes
    // the rule usable: it is scope-wide (one grimoire.toml edit stales every
    // declared row at once) and computeUpdateAvailable no longer reads it, so
    // stepping aside on stale would erase a remembered `true` from the one
    // artifact that really does have an update — every row quiet, including the
    // right one, until the next daily check.
    const drifted = item.state === 'outdated';
    const fields: CheckedFields = {
      update_available: carried,
      deprecated: checked
        ? (item.deprecated ?? null)
        : (item.deprecated ?? previous?.deprecated ?? null),
      replaced_by: checked
        ? (item.replaced_by ?? null)
        : (item.replaced_by ?? previous?.replaced_by ?? null),
    };
    remember[key] = fields;
    return {
      ...item,
      ...fields,
      update_available: item.update_available ?? (drifted ? null : carried),
    };
  });
  return { items: merged, remember };
}

/** True when a persisted entry still has the shape {@link CheckedFields}
 *  promises. Absent fields are NOT coerced to null: the record is written by
 *  {@link mergeCheckedFields}, which always emits all three, so a missing one
 *  means the entry is not ours to trust. */
function isCheckedFields(entry: unknown): entry is CheckedFields {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const fields = entry as Record<string, unknown>;
  return (
    (fields['update_available'] === null || typeof fields['update_available'] === 'boolean') &&
    (fields['deprecated'] === null || typeof fields['deprecated'] === 'string') &&
    (fields['replaced_by'] === null || typeof fields['replaced_by'] === 'string')
  );
}

/** The persisted record with every malformed entry dropped. `CheckStore.read`'s
 *  typed face is a CLAIM, not a guarantee — a Memento-backed store hands back
 *  JSON that round-tripped through disk and can be hand-edited, half-migrated or
 *  written by a future version, and a persisted `null` used to throw inside the
 *  merge and take the whole snapshot down with it. Dropping (never coercing) is
 *  the degrade: `"yes"` is not a verdict, and the artifact costs one round on
 *  the local proxy before the next check re-answers it. */
function validRecord(raw: unknown): Record<string, CheckedFields> {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const valid: Record<string, CheckedFields> = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (isCheckedFields(entry)) {
      valid[key] = entry;
    }
  }
  return valid;
}

export class ScopeService {
  // Last snapshot computed by snapshot(), so the details panel can render real
  // scope/install state in its instant skeleton without awaiting a fresh grim
  // round-trip (item 2). Stale between an action and the next refresh — the
  // details panel replaces the skeleton with a fresh VM ~1s later regardless.
  private lastSnapshot: Snapshot | undefined;

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** The most recent snapshot, if one has been computed this session. */
  cachedSnapshot(): Snapshot | undefined {
    return this.lastSnapshot;
  }

  /** Test seam for the PATH scan (see {@link whichGrim}) — instance-overridable
   *  the same way tests override run(). Yields the ABSOLUTE hit rather than a
   *  boolean because both consumers need it: the spawn as much as the naming
   *  resolution (see {@link resolveExecutable}), so ONE scan answers both
   *  questions instead of one of them scanning and discarding the path it found.
   *  Probes the SAME env the spawn will use (`process.env` merged with
   *  grimoire.extraEnv, see runJson): an extraEnv that sets PATH would otherwise
   *  make the probe and the spawn disagree about which grim exists. */
  pathGrim: () => string | undefined = () =>
    whichGrim({ ...process.env, ...readConfig().extraEnv });

  /** Where the last `--check` verdicts are remembered (see
   *  {@link mergeCheckedFields}). In-memory by default; extension.ts swaps in a
   *  Memento-backed store so they outlive a window reload — the 24h throttle
   *  that gates the next check already does, and a throttle that outlives its
   *  own result is what left a reloaded window on the lock proxy for a day. */
  checkStore: CheckStore = memoryCheckStore();

  /** Per-scope tail of the remembered-verdict read→merge→write chain (see
   *  {@link rememberChecks}). Per scope, not global, so a slow project write
   *  never delays global's merge. */
  private readonly checkChains = new Map<Scope, Promise<unknown>>();

  /**
   * The grim executable to spawn: explicit setting wins; the default `grim`
   * resolves to the PATH hit when there is one, and only otherwise falls back
   * to the extension-managed copy in globalStorage/bin. The bundled copy is a
   * fallback for machines with no grim at all — it must never shadow a
   * user-managed PATH install (it goes stale independently of it).
   *
   * ABSOLUTE for the PATH branch, never the bare `grim` this used to hand the
   * OS: run() spawns with `cwd` set to the workspace folder, and libuv resolves
   * a directory-free name against that cwd BEFORE PATH on Windows — so opening
   * a repository that ships a `grim.exe` in its root ran THAT binary instead of
   * the user's grim, at activation, with no user gesture. Naming the hit is
   * free: {@link pathGrim}'s scan is the same one that answers whether a PATH
   * grim exists at all.
   *
   * One derivation with {@link resolvedExecutable}, so the binary that gets
   * spawned and the binary the grim-info dialog names cannot disagree.
   */
  resolveExecutable(): string {
    return this.resolvedExecutable().path;
  }

  /**
   * The resolution together with the branch it took — for the spawn (see
   * {@link resolveExecutable}) and for every consumer that needs to *name* the
   * binary (`collectGrimInfo`'s Binary/Resolved rows, the version-floor message
   * in `scopeSnapshot`), off one branch rather than three re-derivations.
   *
   * `path` is absolute wherever knowable: for the PATH branch that means the
   * hit {@link whichGrim} found. `origin` is `'missing'` when the setting is the
   * default, {@link pathGrim} finds nothing and no extension-managed copy exists
   * at {@link bundledExecutablePath} — the state `collectGrimInfo` used to
   * mislabel as `'PATH'`. `'bundled'` is the same condition
   * {@link managedExecutable} tests.
   */
  resolvedExecutable(): { path: string; origin: 'setting' | 'PATH' | 'bundled' | 'missing' } {
    const configured = readConfig().executable;
    if (configured !== DEFAULT_EXECUTABLE) {
      return { path: configured, origin: 'setting' };
    }
    const onPath = this.pathGrim();
    if (onPath !== undefined) {
      return { path: onPath, origin: 'PATH' };
    }
    const bundled = this.bundledExecutablePath();
    if (fs.existsSync(bundled)) {
      return { path: bundled, origin: 'bundled' };
    }
    return { path: configured, origin: 'missing' };
  }

  bundledExecutablePath(): string {
    const bin = process.platform === 'win32' ? 'grim.exe' : 'grim';
    return path.join(this.storageUri.fsPath, 'bin', bin);
  }

  /**
   * True when the grim that would actually be spawned is the extension-managed
   * copy — the only case where the update toast may offer to overwrite it in
   * place. Read off the one resolution rather than re-deriving the branch
   * logic at the call site, so the two can never disagree about which binary
   * is in play. The `'bundled'` branch already carries the default-setting
   * gate that matters here: a user who points path.executable AT the bundled
   * path resolves as `'setting'` (user-managed), and we must not overwrite
   * their explicit choice.
   */
  managedExecutable(): boolean {
    return this.resolvedExecutable().origin === 'bundled';
  }

  projectFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * True when project scope has a grimoire.toml (grim reports config_exists).
   * Single source of truth for "is project installable" — installs to a project
   * without a config fail, so callers gate project actions on this.
   */
  async projectConfigured(): Promise<boolean> {
    if (!this.projectFolder()) {
      return false;
    }
    const ctx = await this.run<ContextInfo>(contextArgs(), 'project');
    return ctx.ok && ctx.value.config_exists;
  }

  /**
   * True when the project genuinely has no grimoire.toml — either the probe
   * succeeds with `config_exists: false`, or (the common case in practice;
   * see `isProjectNotDiscovered`) it fails with grim's `NotDiscovered`
   * (code "not-found"). False for any OTHER probe failure: install flows run
   * `grim init` on this signal, and init writes at the cwd while config
   * discovery walks UP, so initializing on a transient probe failure could
   * shadow a parent directory's config. When the probe fails for some other
   * reason, skipping init lets `grim add` surface the real error instead.
   */
  async projectNeedsInit(): Promise<boolean> {
    if (!this.projectFolder()) {
      return false;
    }
    const ctx = await this.run<ContextInfo>(contextArgs(), 'project');
    if (!ctx.ok) {
      return isProjectNotDiscovered(ctx);
    }
    return !ctx.value.config_exists;
  }

  /** Logs which grim binary is actually being spawned — call at activation and on
   *  config change so "which grim ran" is never a mystery (machine-overridable +
   *  bundled-fallback make it non-obvious). */
  logExecutable(): void {
    this.output.appendLine(`grim executable: ${this.resolveExecutable()}`);
  }

  run<T>(args: string[], scope: Scope): Promise<GrimResult<T>> {
    const config = readConfig();
    const options: RunOptions = { env: config.extraEnv };
    const folder = this.projectFolder();
    if (scope === 'project' && folder) {
      options.cwd = folder;
    }
    const executable = this.resolveExecutable();
    // `--global` is grim's top-level flag: prepend it before the subcommand.
    // Appending it blindly at the end lands it *after* the `--` positional
    // separator that a builder adds (searchArgs emits `-- <query>` for free-text
    // queries), where clap parses it as a query term and errors ("unexpected
    // argument"). See withGlobalFlag.
    const scoped = scope === 'global' ? withGlobalFlag(args) : args;
    this.output.appendLine(`> ${executable} ${scoped.join(' ')} (${scope})`);
    return runJson<T>(executable, scoped, options).then((result) => {
      // Name the spawned binary on the two stale/missing-binary signals, so the
      // log self-diagnoses instead of costing a debugging round.
      if (!result.ok && (result.kind === 'not-found' || result.exitCode === 64)) {
        const why =
          result.kind === 'not-found'
            ? 'not found (ENOENT)'
            : 'exited 64 (unrecognized subcommand/argument — stale binary?)';
        this.output.appendLine(`  grim executable '${executable}' ${why}`);
      }
      return result;
    });
  }

  /** One scope's chain: context probe → status (only when configured). Returns
   *  the probe too, so snapshot() can read not-found/error off the global one.
   *  `check` threads to `grim status --check` (network-verified update/deprecation
   *  data); omitted on plain refreshes. */
  private async scopeSnapshot(
    scope: Scope,
    options: { check?: boolean } = {},
  ): Promise<{
    probe: GrimResult<ContextInfo>;
    snapshot: ScopeSnapshot | undefined;
    /** Set when the status call ran and failed — install state is UNKNOWN, not
     *  empty. Callers must surface it: rendering the empty `status` as "nothing
     *  installed" flips every card to Install (e.g. a stale binary rejecting
     *  `status --check` with exit 64). */
    statusError?: string;
  }> {
    const ctx = await this.run<ContextInfo>(contextArgs(), scope);
    if (!ctx.ok) {
      return { probe: ctx, snapshot: undefined };
    }
    // Version floor, checked on the ONE call that reports it (`grim context`)
    // and before any flag a pre-floor grim would reject. Reported through
    // statusError so it lands in snapshot.error like any other unusable-state
    // signal: install state is unknown, not empty. Without this, an old grim
    // fails later on `status --check` with a bare clap usage error and the
    // views blame the wrong thing.
    if (grimTooOld(ctx.value.version)) {
      // Name the ABSOLUTE binary: the default 'grim' spawns whatever the host
      // process's PATH resolves (a WSL vscode-server can hold a days-old PATH
      // snapshot), and "at grim" answers nothing when which-grim-ran is the
      // whole question. resolvedExecutable() is that naming resolution — the
      // same one the grim-info dialog reports, so the two cannot disagree.
      const message = tooOldMessage(this.resolvedExecutable().path, ctx.value.version);
      this.output.appendLine(`  ${message}`);
      // Keep the context. `grim status` is skipped (a pre-floor binary rejects
      // its flags with exit 64) so install state stays UNKNOWN — the same
      // `status: null` + statusError shape a failed status call produces below.
      // Dropping the whole snapshot instead would discard `config_exists`,
      // which `grim context` reports on ANY version: with `project` undefined
      // and `projectProbeFailed` unset (the probe SUCCEEDED — only the floor
      // failed), projectSearchable reads false and pins browse to global scope
      // regardless of the project's real state.
      return {
        probe: ctx,
        snapshot: {
          context: ctx.value,
          status: null,
          statusUnknownReason: 'too-old',
          declared: this.readDeclared(ctx.value),
        },
        statusError: message,
      };
    }
    const status = ctx.value.config_exists
      ? await this.run<StatusEnvelope>(statusArgs(options), scope)
      : undefined;
    const failed = status !== undefined && !status.ok;
    // No config (status undefined) means no installs — a positive empty; a
    // ran-but-failed status is unknown (null), never empty.
    const items =
      status === undefined
        ? []
        : status.ok
          ? await this.rememberChecks(scope, status.value, options.check === true)
          : null;
    return {
      probe: ctx,
      snapshot: {
        context: ctx.value,
        status: items,
        ...(failed ? { statusUnknownReason: 'status-failed' as const } : {}),
        declared: this.readDeclared(ctx.value),
      },
      ...(status && !status.ok
        ? {
            statusError: status.kind === 'not-found' ? 'grim executable not found' : status.message,
          }
        : {}),
    };
  }

  /** Fills this round's `--check`-only fields from the last remembered check
   *  and records the result (see {@link mergeCheckedFields} for the merge rule
   *  and why the badge needs it). One record per scope, so the two scopes'
   *  self-pruning writes can't clobber each other. Also names the one degrade
   *  worth a log line: `--check` was asked for, but grim reports it did not run
   *  online, so the numbers on screen are last-known rather than fresh.
   *
   *  Serialized per scope through {@link checkChains}: read → merge → write is a
   *  read-modify-write over a record every round rewrites in full, and snapshots
   *  overlap routinely — the details host reaches for one from six different
   *  call sites, and the per-panel refresh among them runs once per OPEN PANEL
   *  per round, all outside the refresh coalescer and any of them able to
   *  straddle the daily check. Unordered, a plain round that read before a
   *  checked round's write had landed then wrote its own nulls back over that
   *  scope's fresh verdicts. Ordering is the only tool available:
   *  `vscode.Memento` has no compare-and-swap, so there is nothing to build an
   *  atomic write out of. */
  private rememberChecks(
    scope: Scope,
    envelope: StatusEnvelope,
    checkRequested: boolean,
  ): Promise<StatusItem[]> {
    if (checkRequested && envelope.checked !== true) {
      this.output.appendLine(
        `  grim status --check (${scope}) did not run online (offline?) — update and ` +
          'deprecation data stays last-known',
      );
    }
    // Boundary guard, same as the update summary in extension.ts: an envelope
    // that parses but whose `items` is missing or not an array must not throw.
    const raw = Array.isArray(envelope.items) ? envelope.items : [];
    const merged = (this.checkChains.get(scope) ?? Promise.resolve()).then(() => {
      const stored: unknown = this.checkStore.read(scope);
      const previous = validRecord(stored);
      const { items, remember } = mergeCheckedFields(raw, previous, envelope.checked === true);
      // Only persist a round that actually learned something. Most rounds are
      // plain refreshes that merge the record back unchanged, and the store is
      // backed by disk — a watcher storm would write on every event. Compared
      // against the RAW record, not the validated one: an entry validRecord
      // dropped is missing from `remember` too once its artifact is gone, so
      // against the validated record the two sides match, no write happens and
      // the malformed entry outlives every round — the opposite of pruning it.
      const written =
        JSON.stringify(remember) === JSON.stringify(stored)
          ? Promise.resolve()
          : this.persistChecks(scope, remember);
      return { items, written };
    });
    // What the NEXT round waits on is the WRITE ITSELF — that is the
    // read-after-write guarantee CheckStore asks for. It never rejects: one bad
    // round (a store whose read throws) must not wedge the scope's chain for
    // the session.
    this.checkChains.set(
      scope,
      merged.then(({ written }) => written).catch(() => undefined),
    );
    // THIS round's rows, on the other hand, do not wait for the write at all.
    // They are already correct, and a snapshot() that awaited persistence would
    // hand a storage stall straight to every caller of it.
    return merged.then(({ items }) => items);
  }

  /** Persists one scope's record, never rejecting. A failed persist costs the
   *  NEXT round its memory; it must not cost this one its rows, so the failure
   *  is logged rather than propagated.
   *
   *  The write is AWAITED outright, never raced against a timer. A 5s timeout
   *  lived here (to bound a `vscode.Memento.update` that never settles, which
   *  would hold the scope's chain for the session) and was removed: the race
   *  only lets the chain advance — the abandoned write keeps running. A later
   *  round could then read, merge and persist newer verdicts and have that old
   *  write land on top of them, reverting real verdicts that the next plain
   *  refresh goes on trusting for a day. A lost update is a live bug; a
   *  Thenable that never settles is hypothetical. Do not re-add the timeout. */
  private async persistChecks(
    scope: Scope,
    record: Record<string, CheckedFields>,
  ): Promise<void> {
    try {
      await this.checkStore.write(scope, record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`  remembering ${scope} check verdicts failed: ${message}`);
    }
  }

  /** The scope's declared refs, read off grimoire.toml. Empty when there is no
   *  config or it can't be read — a malformed config is not worth failing the
   *  whole snapshot over. */
  private readDeclared(context: ContextInfo): Record<string, string> {
    if (!context.config_exists) {
      return {};
    }
    try {
      return parseDeclaredRefs(fs.readFileSync(context.config_path, 'utf8'));
    } catch {
      return {};
    }
  }

  /** Gathers both scopes. `grimMissing` is set when the binary is absent. The
   *  global and project chains are independent, so they run in parallel (the
   *  intra-chain context→status order is preserved). `check` is threaded to
   *  `grim status --check` in both scopes for the explicit update check + daily
   *  interval; plain refreshes leave it off (no network). */
  async snapshot(options: { check?: boolean } = {}): Promise<Snapshot> {
    const folder = this.projectFolder();
    const [global, project] = await Promise.all([
      this.scopeSnapshot('global', options),
      folder ? this.scopeSnapshot('project', options) : Promise.resolve(undefined),
    ]);
    if (!global.probe.ok && global.probe.kind === 'not-found') {
      return (this.lastSnapshot = { grimMissing: true });
    }
    const snapshot: Snapshot = { grimMissing: false };
    if (folder !== undefined) {
      snapshot.projectFolder = folder;
    }
    if (global.snapshot) {
      snapshot.global = global.snapshot;
    } else if (!global.probe.ok && global.probe.kind === 'error') {
      snapshot.error = global.probe.message;
      // No global ScopeSnapshot to carry a `status: null`; flag it so the render
      // funnel synthesizes an unknown global scope (see scopeStatuses) rather
      // than treating a failed probe as an empty global.
      snapshot.globalProbeFailed = true;
    }
    // A failed status call means install state is unknown, not empty — surface
    // it so the sidebar shows an error instead of "Install" on installed cards.
    const statusError = global.statusError ?? project?.statusError;
    if (snapshot.error === undefined && statusError !== undefined) {
      snapshot.error = statusError;
    }
    if (project?.snapshot) {
      snapshot.project = project.snapshot;
    } else if (project && !project.probe.ok && !isProjectNotDiscovered(project.probe)) {
      // The project probe failed for a reason OTHER than "no grimoire.toml"
      // (see isProjectNotDiscovered) — flag it so downstream consumers don't
      // read this as "unconfigured" (see projectProbeFailed doc comment).
      // The ordinary no-toml outcome is deliberately left unflagged here: it
      // must read exactly like "unconfigured", the same as a hypothetical
      // config_exists:false success, so projectSearchable's global fallback
      // and the init-offer notice both fire instead of surfacing grim's raw
      // "no grimoire.toml found by walking up..." message.
      snapshot.projectProbeFailed = true;
    }
    this.lastSnapshot = snapshot;
    return snapshot;
  }
}
