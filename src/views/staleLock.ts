// Shared stale-lock recovery for both action hosts (sidebar cards and the
// details header). `grim update <name>` refuses a partial resolve when the
// lock is out of date with grimoire.toml, tagging the error reason:"stale-lock".
// The fix is a full resolve — bare `grim update` in the same scope — which may
// legitimately bump other floating-tag artifacts, so we ask first.
import * as vscode from 'vscode';
import { lockArgs, updateArgs, type ActionReport, type GrimResult, type Scope } from '../grim';
import { reportGrimFailure, runWithStatusProgress } from '../notify';
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
      reportGrimFailure(full, output);
    }
  });
  await onDone();
  return true;
}

/**
 * When a failed command carries reason "no-lock" (install/update with no
 * grimoire.lock yet), offer **Run grim lock** on the error toast: it locks the
 * scope, re-runs the failed command, and calls `onDone`. Returns true when it
 * handled the failure (the caller must then skip its own error notification).
 *
 * Keyed on grim's `reason` alone, never on the message; a grim that does not
 * tag it gets the plain toast from the caller. The toast is NOT awaited, for the
 * same reason as offerInstallRefusal's: an unclicked notification must not hold
 * the caller's busy lock and progress open.
 */
export function offerLock(
  result: FailedResult,
  args: string[],
  scope: Scope,
  scopes: ScopeService,
  output: vscode.OutputChannel,
  onDone: () => Promise<void>,
): boolean {
  if (result.kind !== 'error' || result.reason !== 'no-lock') {
    return false;
  }
  output.appendLine(`error: grim ${args[0]} --${scope}: ${result.message}`);
  const run = async (): Promise<void> => {
    const choice = await vscode.window.showErrorMessage(
      `Grimoire: grim ${args[0]}: ${result.message}`,
      'Run grim lock',
    );
    if (choice !== 'Run grim lock') {
      return;
    }
    await runWithStatusProgress('Locking', async () => {
      for (const step of [lockArgs(), args]) {
        const next = await scopes.run<ActionReport>(step, scope);
        if (!next.ok) {
          reportGrimFailure(next, output, `grim ${step[0]}`);
          return;
        }
      }
    });
    await onDone();
  };
  run().catch((e) => output.appendLine(`lock offer failed: ${String(e)}`));
  return true;
}
