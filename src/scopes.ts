// Scope discovery and per-scope grim invocation. Project scope exists when a
// workspace folder is open; it is *configured* when grim reports
// config_exists (grimoire.toml found by walk-up discovery from the folder).
// Global scope always exists ($GRIM_HOME, default ~/.grimoire).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readConfig, DEFAULT_EXECUTABLE } from './config';
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

  /**
   * Resolves the grim executable: explicit setting wins; the default `grim`
   * falls back to the copy installed into globalStorage/bin when present.
   */
  resolveExecutable(): string {
    const configured = readConfig().executable;
    if (configured !== DEFAULT_EXECUTABLE) {
      return configured;
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
    this.output.appendLine(`> ${executable} ${args.join(' ')} (${scope})`);
    return runJson<T>(executable, scope === 'global' ? [...args, '--global'] : args, options).then(
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
   *  the probe too, so snapshot() can read not-found/error off the global one. */
  private async scopeSnapshot(
    scope: Scope,
  ): Promise<{ probe: GrimResult<ContextInfo>; snapshot: ScopeSnapshot | undefined }> {
    const ctx = await this.run<ContextInfo>(contextArgs(), scope);
    if (!ctx.ok) {
      return { probe: ctx, snapshot: undefined };
    }
    const status = ctx.value.config_exists
      ? await this.run<ItemsEnvelope<StatusItem>>(statusArgs(), scope)
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
    };
  }

  /** Gathers both scopes. `grimMissing` is set when the binary is absent. The
   *  global and project chains are independent, so they run in parallel (the
   *  intra-chain context→status order is preserved). */
  async snapshot(): Promise<Snapshot> {
    const folder = this.projectFolder();
    const [global, project] = await Promise.all([
      this.scopeSnapshot('global'),
      folder ? this.scopeSnapshot('project') : Promise.resolve(undefined),
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
    if (project?.snapshot) {
      snapshot.project = project.snapshot;
    }
    this.lastSnapshot = snapshot;
    return snapshot;
  }
}
