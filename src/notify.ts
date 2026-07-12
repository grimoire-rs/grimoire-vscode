// Host-side user feedback: one shared status-bar progress item for long grim
// runs, and an error toast with opt-in dedupe. Kept out of the webviews (a
// banner on top of the details panel shifts the whole UI) — progress lives in
// the status bar, warnings/errors in the VS Code notification popup.
import * as vscode from 'vscode';

let item: vscode.StatusBarItem | undefined;
let refs = 0;
let visible = false;

/** The one shared status-bar item, created on first use. Click opens the
 *  Grimoire output channel (command registered in extension.ts). */
function statusItem(): vscode.StatusBarItem {
  if (!item) {
    item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
    item.command = 'grimoire.showOutput';
    item.tooltip = 'Click to show Grimoire output';
  }
  return item;
}

/** Registers the shared status-bar item for disposal on deactivate. */
export function initNotify(context: vscode.ExtensionContext): void {
  context.subscriptions.push(statusItem());
}

/** Runs `fn` while a spinning `Grimoire: <title>` shows in the status bar.
 *  Refcounted: concurrent runs show the latest title; the item hides when the
 *  last settles. */
export async function runWithStatusProgress<T>(
  title: string,
  fn: () => Promise<T>,
): Promise<T> {
  const bar = statusItem();
  bar.text = `$(sync~spin) Grimoire: ${title}`;
  refs++;
  visible = true;
  bar.show();
  try {
    return await fn();
  } finally {
    if (--refs === 0) {
      visible = false;
      bar.hide();
    }
  }
}

// Dedupe window for background error sources: an identical message within the
// window is swallowed — collapses the three-view catalog-error burst and
// file-watch revalidation storms into one popup. Timer-free.
const DEDUPE_MS = 5000;
let lastMessage: string | undefined;
let lastAt = 0;

/** Shows an error notification. A distinct user action's failure must never be
 *  swallowed, so dedupe is OPT-IN: only background/burst sources (catalog
 *  refresh fan-out, watch-driven revalidation) pass `dedupe: true`; they drop
 *  a repeat of the same message within the window. Every call records the
 *  message, so a user-action error still arms the dedupe for the background
 *  echo of the same failure. Returns whether it was shown (test seam);
 *  `windowMs` overrides the window so tests can cross it in real time. */
export function notifyError(
  message: string,
  opts?: { dedupe?: boolean; windowMs?: number },
): boolean {
  const now = Date.now();
  const windowMs = opts?.windowMs ?? DEDUPE_MS;
  if (opts?.dedupe === true && message === lastMessage && now - lastAt < windowMs) {
    return false;
  }
  lastMessage = message;
  lastAt = now;
  void vscode.window.showErrorMessage(message);
  return true;
}

/** Test seam: observable status-bar state (StatusBarItem exposes no `visible`). */
export function _statusState(): { visible: boolean; text: string; refs: number } {
  return { visible, text: item?.text ?? '', refs };
}
