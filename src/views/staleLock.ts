// Shared stale-lock recovery for both action hosts (sidebar cards and the
// details header). `grim update <name>` refuses when the lock is out of date
// with grimoire.toml, tagging the error reason:"stale-lock". grim's remedy is
// `grim lock`, then the same update; a grim with pin-keeping lock keeps every
// pin the edit did not touch, so only the named artifact moves. A full resolve
// (bare `grim update`) also works but moves every pin, so it is the second
// choice.
import * as vscode from 'vscode';
import {
  dialogText,
  lockArgs,
  refusedNames,
  updateArgs,
  type ActionReport,
  type GrimResult,
  type Scope,
} from '../grim';
import { reportGrimFailure, runWithStatusProgress } from '../notify';
import type { ScopeService } from '../scopes';
import { offerRefusedRetry } from './forceRetry';
import { offerModifiedRefusal } from './updateRefusal';

type FailedResult = Extract<GrimResult<unknown>, { ok: false }>;

const LOCK_AND_UPDATE = 'Lock and Update';
const FULL_UPDATE = 'Run Full Update';

/**
 * When a failed per-name update carries reason "stale-lock", offer to lock and
 * retry it, or a full update, instead of the plain error toast. Returns true
 * when it handled the failure (the caller must then skip its own error
 * notification); false when this was not a stale-lock error and the caller
 * should fall through.
 *
 * Either choice runs in the same scope under a progress notification, stops at
 * the first failing step and surfaces it via the normal error path, then calls
 * `onDone` (the host's refresh wiring). If `grim lock` finds a pinned manifest
 * gone, it fails with a message that names the full update. Declining is still
 * "handled": the refusal is expected, not an error to toast.
 *
 * An update report that refuses a locally modified artifact is still ok, with
 * the pin moved and the files left alone. The retried named update offers the
 * same Overwrite as the Update button. The full update names the artifacts the
 * way Update All does, with no one-click Overwrite for a whole scope, and
 * without awaiting the notification, so an unclicked one holds no busy state.
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
  const shown = dialogText(name, 60);
  // Says what runs, not which pins hold: that is the grim's to decide, and a
  // grim older than pin-keeping lock re-resolves every floating tag on lock.
  const choice = await vscode.window.showWarningMessage(
    `Grimoire: ${shown}: the lock is out of date with grimoire.toml. Lock and Update runs ` +
      `grim lock, then updates ${shown} again. A full update re-resolves all floating tags ` +
      `and may update other artifacts too.`,
    LOCK_AND_UPDATE,
    FULL_UPDATE,
  );
  if (choice !== LOCK_AND_UPDATE && choice !== FULL_UPDATE) {
    return true;
  }
  const named = choice === LOCK_AND_UPDATE;
  const retry = updateArgs([name]);
  const steps = named ? [lockArgs(), retry] : [updateArgs()];
  // The last step is the update in either case, so its report is the one kept.
  const report = await runWithStatusProgress(
    named ? `Updating ${shown}` : 'Updating all artifacts',
    async () => {
      let last: unknown;
      for (const step of steps) {
        const next = await scopes.run<ActionReport>(step, scope);
        if (!next.ok) {
          reportGrimFailure(next, output, `grim ${step[0]}`);
          return undefined;
        }
        last = next.value;
      }
      return last;
    },
  );
  if (report !== undefined && named) {
    await offerRefusedRetry(report, retry, scope, scopes, output);
  } else if (report !== undefined) {
    const refused = refusedNames(report);
    if (refused.length > 0) {
      output.appendLine(
        `grim update (${scope}): refused to overwrite locally-modified ` +
          `${refused.join(', ')} — files left in place, lock pin moved`,
      );
      // Caught, not bare `void`: nothing awaits it, and a button clicked after a
      // reload rejects, as offerInstallRefusal's does.
      void offerModifiedRefusal(scopes, scope, 'update', { refused }).catch((e) =>
        output.appendLine(`update refusal notice failed: ${String(e)}`),
      );
    }
  }
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
      `Grimoire: grim ${args[0]}: ${dialogText(result.message, 1000)}`,
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
