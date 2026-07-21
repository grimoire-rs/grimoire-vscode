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
  status: StatusItem[];
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

  bundledExecutablePath(): string {
    const bin = process.platform === 'win32' ? 'grim.exe' : 'grim';
    return path.join(this.storageUri.fsPath, 'bin', bin);
  }

  /**
   * True when the grim that would actually be spawned is the extension-managed
   * copy — the only case where the update toast may offer to overwrite it in
   * place. Derived from resolveExecutable() itself rather than re-deriving the
   * branch logic at the call site, so the two can never disagree about which
   * binary is in play. The default-setting gate matters: a user who points
   * path.executable AT the bundled path is user-managed, and we must not
   * overwrite their explicit choice.
   */
  managedExecutable(): boolean {
    return (
      readConfig().executable === DEFAULT_EXECUTABLE &&
      this.resolveExecutable() === this.bundledExecutablePath()
    );
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
      // whole question.
      const executable = this.resolveExecutable();
      const resolved =
        executable === DEFAULT_EXECUTABLE
          ? (whichGrim({ ...process.env, ...readConfig().extraEnv }) ?? executable)
          : executable;
      const message = tooOldMessage(resolved, ctx.value.version);
      this.output.appendLine(`  ${message}`);
      return { probe: ctx, snapshot: undefined, statusError: message };
    }
    const status = ctx.value.config_exists
      ? await this.run<ItemsEnvelope<StatusItem>>(statusArgs(options), scope)
      : undefined;
    let declared: Record<string, string> = {};
    try {
      if (ctx.value.config_exists) {
        declared = parseDeclaredRefs(fs.readFileSync(ctx.value.config_path, 'utf8'));
      }
    } catch {
      // unreadable config: leave declared empty
    }
    return {
      probe: ctx,
      snapshot: { context: ctx.value, status: status?.ok ? status.value.items : [], declared },
      ...(status && !status.ok
        ? {
            statusError:
              status.kind === 'not-found' ? 'grim executable not found' : status.message,
          }
        : {}),
    };
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
