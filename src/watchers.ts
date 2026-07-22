// File watchers that refresh the views when grim state changes underneath
// us: project grimoire.toml/lock + .grimoire/state.json, and the global
// counterparts under $GRIM_HOME (outside the workspace — RelativePattern on a
// Uri handles that): grimoire.toml/lock and state/global.json (grim's global
// install state).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readConfig } from './config';

// grim's install writes straddle multi-hundred-ms quiet gaps (grimoire.toml
// early, network, lock/state late), so refresh only after ~a second of quiet.
const DEBOUNCE_MS = 1000;

export class Watchers implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private suspendDepth = 0;
  /** What the currently-armed watcher set was built from — see rebuild(). */
  private armedKey: string | undefined;

  // debounceMs is injectable so tests don't sleep real seconds.
  constructor(
    private readonly onChange: () => void,
    private readonly debounceMs: number = DEBOUNCE_MS,
  ) {}

  /** Re-entrant: drops watcher-driven refreshes for the duration of fn. Every
   *  extension-initiated mutation refreshes explicitly on completion, so the
   *  events its OWN writes fire are redundant. Events while suspended are dropped
   *  (finally-safe); the completion refresh reads fresh state, external edits
   *  included, so nothing is lost. */
  async suspendWhile<T>(fn: () => Promise<T>): Promise<T> {
    this.suspendDepth++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      return await fn();
    } finally {
      this.suspendDepth--;
    }
  }

  /** (Re)builds watchers for the given grim home + workspace folders.
   *  Idempotent: an unchanged input is a no-op, so callers may re-arm freely
   *  (refreshAll does, to self-heal a probe that failed at activation) without
   *  churning FileSystemWatchers or opening a window where events fall between
   *  a dispose and its replacement. */
  rebuild(grimHome: string | undefined): void {
    const watchForChanges = readConfig().watchForChanges;
    const key = JSON.stringify([
      grimHome ?? null,
      watchForChanges,
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()),
    ]);
    if (key === this.armedKey) {
      return;
    }
    this.armedKey = key;
    this.disposeWatchers();
    if (!watchForChanges) {
      return;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      this.watch(new vscode.RelativePattern(folder, '{grimoire.toml,grimoire.lock}'));
      this.watch(new vscode.RelativePattern(folder, '.grimoire/state.json'));
    }
    if (grimHome) {
      const home = vscode.Uri.file(grimHome);
      this.watch(new vscode.RelativePattern(home, '{grimoire.toml,grimoire.lock}'));
      // Global install state lives at $GRIM_HOME/state/global.json (grim's
      // store layout). Watch the state dir directly (base = state/, file a
      // direct child) so a global install/uninstall refreshes the views — the
      // project scope's .grimoire/state.json is already watched per folder.
      // A fresh grim home may not have state/ yet, and this non-recursive,
      // non-workspace watcher only arms against an existing base dir — create
      // it (harmless: grim creates it itself on first global install) so the
      // watcher isn't dead on arrival.
      try {
        fs.mkdirSync(path.join(grimHome, 'state'), { recursive: true });
      } catch {
        // Permissions or other failure: fall back to the old (may-never-fire
        // until grim creates the dir and the view rebuilds) behavior.
      }
      this.watch(new vscode.RelativePattern(vscode.Uri.joinPath(home, 'state'), 'global.json'));
    }
  }

  private watch(pattern: vscode.RelativePattern): void {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const fire = () => this.fireDebounced();
    watcher.onDidChange(fire);
    watcher.onDidCreate(fire);
    watcher.onDidDelete(fire);
    this.disposables.push(watcher);
  }

  private fireDebounced(): void {
    if (this.suspendDepth > 0) {
      return; // our own write during a suspended action — redundant, drop it
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onChange();
    }, this.debounceMs);
  }

  private disposeWatchers(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.armedKey = undefined; // disposed: the next rebuild must actually arm
    this.disposeWatchers();
  }
}
