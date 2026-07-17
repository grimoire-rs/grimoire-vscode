import * as vscode from 'vscode';
import type { Scope } from './grim';

export interface GrimoireConfig {
  executable: string;
  defaultScope: Scope;
  watchForChanges: boolean;
  prefetchDetails: boolean;
  checkForUpdates: boolean;
  extraEnv: Record<string, string>;
}

export const DEFAULT_EXECUTABLE = 'grim';

/** Reads the extension settings at point-of-use (never cached). */
export function readConfig(): GrimoireConfig {
  const cfg = vscode.workspace.getConfiguration('grimoire');
  const defaultScope = cfg.get<string>('defaultScope', 'project');
  return {
    executable: cfg.get<string>('path.executable', DEFAULT_EXECUTABLE) || DEFAULT_EXECUTABLE,
    defaultScope: defaultScope === 'global' ? 'global' : 'project',
    watchForChanges: cfg.get<boolean>('watchForChanges', true),
    prefetchDetails: cfg.get<boolean>('prefetchDetails', true),
    checkForUpdates: cfg.get<boolean>('checkForUpdates', true),
    extraEnv: cfg.get<Record<string, string>>('extraEnv', {}),
  };
}
