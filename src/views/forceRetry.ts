// Shared force-retry recovery for both action hosts (sidebar cards and the
// details header). `grim add`/`grim update` refuse when the destination is
// locally modified or an untracked file is in the way, tagging the error
// forceable:true — retrying the same call with `--force` appended overwrites,
// so we confirm first. A structurally different refusal shares this helper:
// reason:"anchor-escape" is never forceable (a symlink escaping the anchor
// root is a security refusal, not a drift refusal) and gets a non-modal
// notice with no override control instead of a confirm dialog.
import * as vscode from 'vscode';
import { isForceable, type ActionReport, type GrimResult, type Scope } from '../grim';
import { reportGrimFailure, runWithStatusProgress } from '../notify';
import type { ScopeService } from '../scopes';
import { artifactName, refRepo } from '../webview/model';

type FailedResult = Extract<GrimResult<unknown>, { ok: false }>;

/**
 * When a failed add/update carries `forceable: true`, offer a retry with
 * `--force` appended instead of the plain error toast. When it instead
 * carries reason "anchor-escape", show a non-modal notice pointing at the
 * output channel — that refusal is a security boundary, so no override is
 * ever offered. Returns true when it handled the failure (the caller must
 * then skip its own error notification); false when neither applies and the
 * caller should fall through to the generic error path.
 *
 * On confirmation it reissues `args` with `--force` appended — only `add`
 * and `update` accept the flag, so the flag is appended only when `args[0]`
 * is one of those (`grim uninstall` has no `--force` flag, and forceable
 * refusals never originate from uninstall anyway) — under a progress
 * notification, surfaces any failure via the normal error path, and calls
 * `onDone` (the host's refresh wiring). Declining is still "handled" — the
 * refusal is expected, not an error to toast.
 */
export async function offerForcedRetry(
  result: FailedResult,
  args: string[],
  scope: Scope,
  scopes: ScopeService,
  output: vscode.OutputChannel,
  onDone: () => Promise<void>,
): Promise<boolean> {
  if (result.kind !== 'error') {
    return false;
  }
  // grim's own binding-name rule (`id.name()` off the parsed OCI identifier,
  // ../grimoire/src/command/add.rs:162) strips a trailing tag — refRepo does
  // that, artifactName then takes the last path segment. A bare `grim update`
  // name (e.g. "demo") has no slash or tag, so it passes through unchanged.
  const name = artifactName(refRepo(args[1] ?? ''));
  // Normalized, not `===`: a case/whitespace variant of this reason arriving
  // together with forceable:true must still take the security branch below,
  // never the override branch — see CWE-697/CWE-20 in the anchor-escape ADR.
  if (result.reason?.trim().toLowerCase() === 'anchor-escape') {
    const choice = await vscode.window.showErrorMessage(
      `Grimoire: \`${name}\`: a recorded path resolves outside its anchor root. grim will not ` +
        `read or write through it. Uninstall and reinstall it to repair. Files may remain on ` +
        `disk and must be removed manually.`,
      'Show Output',
    );
    if (choice === 'Show Output') {
      await vscode.commands.executeCommand('grimoire.showOutput');
    }
    return true;
  }
  if (isForceable(result) && (args[0] === 'add' || args[0] === 'update')) {
    const detail =
      `Reinstalling discards your local changes to \`${name}\`. This cannot be undone.\n\n` +
      result.message;
    const choice = await vscode.window.showWarningMessage(
      `Grimoire: overwrite \`${name}\`?`,
      { modal: true, detail },
      'Overwrite',
    );
    if (choice !== 'Overwrite') {
      return true;
    }
    await runWithStatusProgress(`Overwriting ${name}`, async () => {
      const retry = await scopes.run<ActionReport>([...args, '--force'], scope);
      if (!retry.ok) {
        reportGrimFailure(retry, output, `grim ${args[0]}`);
      }
    });
    await onDone();
    return true;
  }
  return false;
}
