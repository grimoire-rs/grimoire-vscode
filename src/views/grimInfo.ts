// "Show grim Info" — which grim would actually be spawned, and what it reports.
//
// The extension resolves its binary as setting → PATH → extension-managed
// fallback (ScopeService.resolveExecutable), so a shell's `grim --version` need
// not be the grim the extension runs — a WSL/remote host process can hold a
// stale PATH snapshot. Without this, "which grim is this?" costs a debugging
// round every time a version-skew symptom shows up.
import * as vscode from 'vscode';
import { contextArgs, type ContextInfo } from '../grim';
import { MINIMUM_GRIM_VERSION, grimTooOld } from '../installer';
import type { ScopeService } from '../scopes';

const COPY = 'Copy';
const SHOW_OUTPUT = 'Show Output';

/** How ScopeService.resolvedExecutable() arrived at the binary — the branch,
 *  not the path. Mirrors that return type; `'missing'` is a real state (no
 *  setting, no grim on PATH, no extension-managed copy) and reporting it as
 *  `'PATH'` named a binary that is nowhere. */
export type GrimOrigin = 'setting' | 'PATH' | 'bundled' | 'missing';

export interface GrimInfo {
  /** Absolute where knowable; the bare `grim` only when PATH holds no grim. */
  path: string;
  origin: GrimOrigin;
  /** Null when the context probe failed — then `error` says why. */
  version: string | null;
  grimHome: string | null;
  /** Global scope's grimoire.toml. Labelled as global so an open project
   *  can't read this as its own config (the two scopes never merge). */
  globalConfigPath: string | null;
  globalConfigExists: boolean;
  offline: boolean | null;
  defaultRegistry: string | null;
  error?: string;
}

/** Pure formatter: {@link GrimInfo} → the modal's summary + detail body.
 *  Exported for tests. */
export function formatGrimInfo(info: GrimInfo): { summary: string; detail: string } {
  const summary =
    info.version === null
      ? 'grim did not report a version'
      : grimTooOld(info.version)
        ? `grim ${info.version}  ✗ older than the required ${MINIMUM_GRIM_VERSION}`
        : `grim ${info.version}  ✓ meets floor ${MINIMUM_GRIM_VERSION}`;
  const rows: [string, string][] = [
    ['Binary', info.path],
    ['Resolved', originLabel(info.origin)],
  ];
  if (info.grimHome !== null) {
    rows.push(['Home', info.grimHome]);
  }
  if (info.globalConfigPath !== null) {
    rows.push([
      'Global config',
      `${info.globalConfigPath}${info.globalConfigExists ? '' : ' (does not exist)'}`,
    ]);
  }
  if (info.offline !== null) {
    rows.push(['Offline', info.offline ? 'yes' : 'no']);
  }
  // Only a probe that answered knows there is no registry configured. Pushed
  // unconditionally, "Registry  none configured" printed directly above
  // "Error  grim executable not found" — a claim about a grim that never ran.
  // (`version === null` IS the failed probe; see the field's doc.)
  if (info.version !== null) {
    rows.push(['Registry', info.defaultRegistry ?? 'none configured']);
  }
  if (info.error !== undefined) {
    rows.push(['Error', info.error]);
  }
  // No padEnd: the modal renders in a proportional font, so column padding
  // aligns nothing and only widens the copied text.
  const detail = rows.map(([label, value]) => `${label}: ${value}`).join('\n');
  return { summary, detail };
}

function originLabel(origin: GrimOrigin): string {
  switch (origin) {
    case 'setting':
      return 'grimoire.path.executable setting';
    case 'bundled':
      return 'extension-managed copy (no grim on PATH)';
    case 'PATH':
      return 'PATH';
    case 'missing':
      return 'not found (no setting, no grim on PATH, no extension-managed copy)';
    default: {
      const exhaustive: never = origin;
      throw new Error(`unhandled origin: ${String(exhaustive)}`);
    }
  }
}

/** Resolves the binary the same way a spawn would, then probes it once.
 *  Global scope: it never fails for lack of a project grimoire.toml, and it is
 *  the scope that reports the version/home/default-registry facts. */
export async function collectGrimInfo(scopes: ScopeService): Promise<GrimInfo> {
  // Reported, never re-derived: this dialog exists to answer "which grim would
  // actually be spawned", and its own copy of the setting → PATH → bundled
  // branch is what made it claim `Resolved: PATH` for a binary that is nowhere.
  const { path, origin } = scopes.resolvedExecutable();
  const ctx = await scopes.run<ContextInfo>(contextArgs(), 'global');
  if (!ctx.ok) {
    return {
      path,
      origin,
      version: null,
      grimHome: null,
      globalConfigPath: null,
      globalConfigExists: false,
      offline: null,
      defaultRegistry: null,
      error: ctx.kind === 'not-found' ? 'grim executable not found' : ctx.message,
    };
  }
  return {
    path,
    origin,
    version: ctx.value.version,
    grimHome: ctx.value.grim_home,
    globalConfigPath: ctx.value.config_path,
    globalConfigExists: ctx.value.config_exists,
    offline: ctx.value.offline,
    defaultRegistry: ctx.value.default_registry,
  };
}

export async function showGrimInfo(scopes: ScopeService): Promise<void> {
  const info = await collectGrimInfo(scopes);
  const { summary, detail } = formatGrimInfo(info);
  const choice = await vscode.window.showInformationMessage(
    summary,
    { modal: true, detail },
    COPY,
    SHOW_OUTPUT,
  );
  if (choice === COPY) {
    await vscode.env.clipboard.writeText(`${summary}\n\n${detail}`);
  } else if (choice === SHOW_OUTPUT) {
    await vscode.commands.executeCommand('grimoire.showOutput');
  }
}
