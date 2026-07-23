// Scope discovery and per-scope grim invocation. Project scope exists when a
// workspace folder is open; it is *configured* when grim reports
// config_exists (grimoire.toml found by walk-up discovery from the folder).
// Global scope always exists ($GRIM_HOME, default ~/.grimoire).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readConfig, DEFAULT_EXECUTABLE } from './config';
import { grimTooOld, tooOldMessage } from './installer';
import {
  contextArgs,
  statusArgs,
  runJson,
  type ContextInfo,
  type GrimResult,
  type ItemsEnvelope,
  type RunOptions,
  type Scope,
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
   *  that is why this is `| null` rather than a sibling flag. */
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

/** Parses declared name -> ref pairs out of a grimoire.toml. Pure; exported for tests. */
export function parseDeclaredRefs(toml: string): Record<string, string> {
  // ponytail: hand-rolled line parser instead of a TOML dep at runtime — the
  // config format is flat `[section]` tables of `name = "ref"` pairs.
  const declared: Record<string, string> = {};
  let inArtifactTable = false;
  const tables = new Set(['skills', 'rules', 'agents', 'bundles', 'mcp']);
  for (const rawLine of toml.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inArtifactTable = tables.has(line.replace(/[[\]]/g, '').trim());
      continue;
    }
    if (!inArtifactTable || line.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z0-9._-]+)\s*=\s*"([^"]+)"/.exec(line);
    if (match && match[1] && match[2]) {
      declared[match[1]] = match[2];
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
        const candidate = path.join(dir, `grim${ext}`);
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

/** Boolean face of {@link whichGrim}. */
export function grimOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  return whichGrim(env) !== undefined;
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
  return (snapshot.project?.context.config_exists ?? false) || (snapshot.projectProbeFailed ?? false);
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

  /** Test seam for the PATH probe (see grimOnPath) — instance-overridable the
   *  same way tests override run(). Probes the SAME env the spawn will use
   *  (`process.env` merged with grimoire.extraEnv, see runJson): an extraEnv
   *  that sets PATH would otherwise make the probe and the spawn disagree about
   *  whether a PATH grim exists. */
  pathHasGrim: () => boolean = () => grimOnPath({ ...process.env, ...readConfig().extraEnv });

  /**
   * Resolves the grim executable: explicit setting wins; the default `grim`
   * uses PATH when a grim exists there, and only otherwise falls back to the
   * extension-managed copy in globalStorage/bin. The bundled copy is a
   * fallback for machines with no grim at all — it must never shadow a
   * user-managed PATH install (it goes stale independently of it).
   *
   * The spawn path: it needs the boolean {@link pathHasGrim}, never the
   * absolute PATH hit, so it deliberately does NOT route through
   * {@link resolvedExecutable} — that would charge every grim call a second
   * PATH scan just to name a binary the OS resolves itself.
   */
  resolveExecutable(): string {
    const configured = readConfig().executable;
    if (configured !== DEFAULT_EXECUTABLE) {
      return configured;
    }
    if (this.pathHasGrim()) {
      return configured; // 'grim' — the spawn resolves it via PATH
    }
    const bundled = this.bundledExecutablePath();
    if (bundled && fs.existsSync(bundled)) {
      return bundled;
    }
    return configured;
  }

  /**
   * The resolution of {@link resolveExecutable} together with the branch it
   * took — the single source for every consumer that needs to *name* the binary
   * rather than just spawn it (`collectGrimInfo`'s Binary/Resolved rows, the
   * version-floor message in `scopeSnapshot`), both of which re-derive the
   * setting → PATH → bundled branch today and can disagree with the spawn.
   *
   * `path` is absolute wherever knowable: for the PATH branch that means the
   * hit {@link whichGrim} found, not the bare `grim` the spawn passes to the OS.
   * `origin` is `'missing'` when the setting is the default, {@link pathHasGrim}
   * is false and no extension-managed copy exists at
   * {@link bundledExecutablePath} — the state `resolveExecutable` reports as a
   * bare `grim` and `collectGrimInfo` currently mislabels as `'PATH'`.
   * `'bundled'` is the same condition {@link managedExecutable} tests.
   * The PATH scan runs only behind `pathHasGrim()`, so the no-grim-anywhere
   * state does not pay for a full scan twice.
   */
  resolvedExecutable(): { path: string; origin: 'setting' | 'PATH' | 'bundled' | 'missing' } {
    const configured = readConfig().executable;
    if (configured !== DEFAULT_EXECUTABLE) {
      return { path: configured, origin: 'setting' };
    }
    if (this.pathHasGrim()) {
      // Only the naming scan, and only behind the boolean gate: whichGrim
      // early-returns on the first hit, so this costs a hit-length scan here
      // and nothing at all in the no-grim-anywhere state below.
      return {
        path: whichGrim({ ...process.env, ...readConfig().extraEnv }) ?? configured,
        origin: 'PATH',
      };
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
    return runJson<T>(executable, scoped, options).then(
      (result) => {
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
      },
    );
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
      ? await this.run<ItemsEnvelope<StatusItem>>(statusArgs(options), scope)
      : undefined;
    const failed = status !== undefined && !status.ok;
    return {
      probe: ctx,
      snapshot: {
        context: ctx.value,
        // No config (status undefined) means no installs — a positive empty;
        // a ran-but-failed status is unknown (null), never empty.
        status: status === undefined ? [] : status.ok ? status.value.items : null,
        ...(failed ? { statusUnknownReason: 'status-failed' as const } : {}),
        declared: this.readDeclared(ctx.value),
      },
      ...(status && !status.ok
        ? {
            statusError:
              status.kind === 'not-found' ? 'grim executable not found' : status.message,
          }
        : {}),
    };
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
