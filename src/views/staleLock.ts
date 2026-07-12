// Shared stale-lock recovery for both action hosts (sidebar cards and the
// details header). `grim update <name>` refuses a partial resolve when the
// lock is out of date with grimoire.toml, tagging the error reason:"stale-lock".
// The fix is a full resolve — bare `grim update` in the same scope — which may
// legitimately bump other floating-tag artifacts, so we ask first.
import * as vscode from 'vscode';
import { updateArgs, type ActionReport, type GrimResult, type Scope } from '../grim';
import { notifyError, runWithStatusProgress } from '../notify';
import type { ScopeService } from '../scopes';

type FailedResult = Extract<GrimResult<unknown>, { ok: false }>;

/**
 * When a failed per-name update carries reason "stale-lock", offer a full
 * update instead of the plain error toast. Returns true when it handled the
 * failure (the caller must then skip its own error notification); false when
 * this was not a stale-lock error and the caller should fall through.
 *
 * On confirmation it runs bare `grim update` in the same scope under a progress
 * notification, surfaces any failure via the normal error path, and calls
 * `onDone` (the host's refresh wiring). Declining is still "handled" — the
 * partial-resolve refusal is expected, not an error to toast.
 */
export async function offerFullUpdate(
  result: FailedResult,
  name: string,
  scope: Scope,
  scopes: ScopeService,
  output: vscode.OutputChannel,
  onDone: () => Promise<void>,
): Promise<boolean> {
  if (result.kind !== 'error' || result.reason !== 'stale-lock') {
    return false;
  }
  const choice = await vscode.window.showWarningMessage(
    `Grimoire: ${name}: the lock is out of date with grimoire.toml. A full update ` +
      `re-resolves all floating tags and may update other artifacts too.`,
    'Run Full Update',
  );
  if (choice !== 'Run Full Update') {
    return true;
  }
  await runWithStatusProgress('Updating all artifacts', async () => {
    const full = await scopes.run<ActionReport>(updateArgs(), scope);
    if (!full.ok) {
      const message = full.kind === 'not-found' ? 'grim executable not found' : full.message;
      output.appendLine(`error: ${message}`);
      notifyError(`Grimoire: ${message}`);
    }
  });
  await onDone();
  return true;
}
