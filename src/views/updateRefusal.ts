// Shared recovery for a SCOPE-WIDE grim refusal — `grim update` with no name,
// and `grim install` (the Complete Install remedy). Both run against a whole
// scope, and both stop on the first locally-modified artifact they meet.
//
// Deliberately NOT the Overwrite dialog forceRetry.ts offers. Retrying either
// call with `--force` would overwrite EVERY modified artifact in the scope while
// grim's message names only the one it hit first — so this names them from the
// snapshot instead (structural, never scraped out of grim's prose) and offers to
// open one, whose own per-artifact Update button confirms and forces that
// artifact alone. Second consumer of `forceable` that deliberately declines to
// expose a force: the flag describes what grim CAN do, not what the client
// should offer (adr_anchor_escape_recovery, Decision 3).
//
// Lives in views/ rather than extension.ts because views/*.ts never imports
// ../extension — the dependency edge is one-way, and both action hosts plus the
// activation module need this.
import * as vscode from 'vscode';
import { isForceable, type GrimResult, type Scope } from '../grim';
import type { ScopeService } from '../scopes';
import { declaredKey, refRepo } from '../webview/model';

type FailedResult = Extract<GrimResult<unknown>, { ok: false }>;

/** Names the locally-modified artifacts in a scope and offers a way into one.
 *
 * `operation` only spells the verb in the message; the two callers are a bare
 * `grim update` and a scope-wide `grim install`. A literal union rather than a
 * free string so the two call sites cannot drift into different wording.
 *
 * The snapshot is `cachedSnapshot()` first: it is what the last refresh saw, and
 * nothing watches materialized artifact files, so a file edited since then is
 * invisible here. That is why the unnamed form below exists — it is reached
 * precisely when grim's own refusal is right and our snapshot is behind.
 */
export async function offerModifiedRefusal(
  scopes: ScopeService,
  scope: Scope,
  operation: 'update' | 'install',
  message: string,
): Promise<void> {
  const snapshot = scopes.cachedSnapshot() ?? (await scopes.snapshot());
  const snap = snapshot[scope];
  const modified = (snap?.status ?? []).filter((item) => item.state === 'modified');
  const repos = new Map<string, string>();
  for (const item of modified) {
    const declared = snap?.declared[declaredKey(item.kind, item.name)];
    const ref = declared ?? item.pinned;
    if (ref) {
      repos.set(item.name, refRepo(ref));
    }
  }
  const only = repos.size === 1 ? [...repos.entries()][0] : undefined;
  if (only) {
    const [name, repo] = only;
    const choice = await vscode.window.showErrorMessage(
      `Grimoire: ${operation} stopped — ${message}`,
      `Open ${name}`,
      'Show Output',
    );
    if (choice === `Open ${name}`) {
      await vscode.commands.executeCommand('grimoire.openDetails', repo);
    } else if (choice === 'Show Output') {
      await vscode.commands.executeCommand('grimoire.showOutput');
    }
    return;
  }
  const named = repos.size > 1 ? ` Locally modified: ${[...repos.keys()].join(', ')}.` : '';
  const choice = await vscode.window.showErrorMessage(
    `Grimoire: ${operation} (${scope}) stopped — ${message}${named}`,
    'Show Output',
  );
  if (choice === 'Show Output') {
    await vscode.commands.executeCommand('grimoire.showOutput');
  }
}

/**
 * The fallback-chain member for a refused `grim install`. Returns true when it
 * handled the failure (the caller must then skip its own error notification),
 * false when this is not that refusal and the caller should fall through.
 *
 * Wired AFTER offerForcedRetry in both hosts so the anchor-escape branch still
 * wins — that one is a security refusal and must never reach a dialog that
 * talks about local modifications.
 *
 * The output line is written here and is not optional: returning true skips the
 * caller's reportGrimFailure, which is what would otherwise have logged the very
 * line this dialog's own "Show Output" button sends the user to.
 *
 * The dialog is NOT awaited, unlike offerForcedRetry's. That one is a confirm:
 * the retry it gates cannot proceed until the user answers. This one only
 * informs, so nothing downstream needs its answer — and awaiting it would hold
 * the busy lock and watcher suspension of a scope-wide install open for as long
 * as the notification sits unclicked, which is the shape Update All was just
 * fixed to stop doing. The button handlers still run when the user gets to them.
 */
export function offerInstallRefusal(
  result: FailedResult,
  args: string[],
  scope: Scope,
  scopes: ScopeService,
  output: vscode.OutputChannel,
): boolean {
  if (result.kind !== 'error' || args[0] !== 'install' || !isForceable(result)) {
    return false;
  }
  output.appendLine(`error: grim install --${scope}: ${result.message}`);
  // Caught, not bare `void`: nothing awaits this any more, and it outlives the
  // action. The user can click `Open <name>` minutes later — after a reload, by
  // which point executeCommand rejects with "command not found" — and the
  // snapshot fallback inside can reject too. An unhandled rejection in the
  // extension host would leave nothing in the channel this dialog's own
  // "Show Output" button points at.
  void offerModifiedRefusal(scopes, scope, 'install', result.message).catch((e) =>
    output.appendLine(`install refusal notice failed: ${String(e)}`),
  );
  return true;
}
