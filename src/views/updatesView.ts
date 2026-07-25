// Owner of the "updates available" count on the activity-bar icon.
//
// The count used to live on the sidebar's WebviewView badge, which is only
// reachable through the object VS Code hands to resolveWebviewView — and it
// calls that "when a view first becomes visible" (vscode.d.ts). A window whose
// Grimoire container was never opened therefore had no count at all, which is
// most of why the badge read as unreliable: whether it appeared depended on
// whether the view happened to be restored on startup. A TreeView object exists
// the moment createTreeView returns, so its badge (and the container rollup)
// works from activation onward.
import * as vscode from 'vscode';

export const UPDATES_VIEW_ID = 'grimoire.updates';

/** The one row, which exists only to give the view something to show and a
 *  place to click through from. */
const ROW = 'updates';

export class UpdatesView implements vscode.TreeDataProvider<string>, vscode.Disposable {
  private count = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<string>;

  constructor() {
    this.view = vscode.window.createTreeView(UPDATES_VIEW_ID, { treeDataProvider: this });
  }

  /** The single write point for the count. Sets the badge and the
   *  `grimoire.updatesAvailable` context key together — the key both gates this
   *  view's own `when` clause (no updates, no row, no container clutter) and
   *  shows the conditional Update All toolbar icon, so badge and icon cannot
   *  disagree. Called only by SidebarProvider.setBadge. */
  setCount(count: number): void {
    if (count === this.count) {
      // Every refresh publishes a count, and most refreshes publish the same
      // one — a watcher storm would otherwise fire a context-key command and a
      // tree rebuild per event for no visible change.
      return;
    }
    this.count = count;
    this.view.badge = count > 0 ? { value: count, tooltip: `${count} available` } : undefined;
    void vscode.commands.executeCommand('setContext', 'grimoire.updatesAvailable', count > 0);
    this.changed.fire();
  }

  /** Test seam: what the activity bar is currently showing. */
  badge(): vscode.ViewBadge | undefined {
    return this.view.badge;
  }

  getChildren(): string[] {
    return this.count > 0 ? [ROW] : [];
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.count === 1 ? '1 update available' : `${this.count} updates available`,
    );
    item.iconPath = new vscode.ThemeIcon('arrow-circle-up');
    item.command = { command: 'grimoire.showUpdates', title: 'Show Updates' };
    return item;
  }

  dispose(): void {
    this.view.dispose();
    this.changed.dispose();
  }
}
