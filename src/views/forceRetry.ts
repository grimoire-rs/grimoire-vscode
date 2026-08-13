// Shared force-retry recovery for both action hosts (sidebar cards and the
// details header). `grim add`/`grim update` refuse when the destination is
// locally modified or an untracked file is in the way, tagging the error
// forceable:true — retrying the same call with `--force` appended overwrites,
// so we confirm first. A structurally different refusal shares this helper:
// reason:"anchor-escape" is never forceable (a symlink escaping the anchor
// root is a security refusal, not a drift refusal) and gets a non-modal
// notice with no override control instead of a confirm dialog.
//
// TWO wire shapes reach the same confirm. `add`/`install` still refuse with an
// error document (offerForcedRetry); grim ≥ 0.13.0's `update` refuses with a
// normal report carrying `refused` on the row (offerRefusedRetry) — because
// that refusal is partial and the report it used to discard described work that
// had already happened. They are told apart by the payload, never by a version.
import * as vscode from 'vscode';
import {
  isForceable,
  positionalOf,
  refusedNames,
  withFlags,
  type ActionReport,
  type GrimResult,
  type Scope,
} from '../grim';
import { reportGrimFailure, runWithStatusProgress } from '../notify';
import type { ScopeService } from '../scopes';
import { artifactName, refRepo } from '../webview/model';

type FailedResult = Extract<GrimResult<unknown>, { ok: false }>;

/** What `--force` authorizes on `update` beyond the overwrite itself: the
 *  deletions the same run declined. Appended LAST to a dialog detail so grim's
 *  own message stays contiguous with the sentence that introduces it. */
const FORCE_UPDATE_NOTE =
  '\n\nOn an update, --force also authorizes the deletions this run declined: ' +
  'pruned lock entries and stale client output.';

/** The Overwrite confirm both refusal shapes end in: a modal warning, and on
 *  confirmation the same argv reissued with `--force` under a progress
 *  notification. Returns true when the retry actually ran, false when declined
 *  — the callers differ on what they owe afterwards.
 *
 *  Only the detail prose is a parameter: the two shapes describe different
 *  outcomes (a pre-0.13 error document stopped the whole run; a 0.13 refused row
 *  did not), and nothing else about the confirm differs. */
async function confirmOverwrite(
  name: string,
  detail: string,
  args: string[],
  scope: Scope,
  scopes: ScopeService,
  output: vscode.OutputChannel,
): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Grimoire: overwrite \`${name}\`?`,
    { modal: true, detail },
    'Overwrite',
  );
  if (choice !== 'Overwrite') {
    return false;
  }
  await runWithStatusProgress(`Overwriting ${name}`, async () => {
    // withFlags, not a tail append: the builders end in `-- <positional>`, so
    // an appended --force would parse as a second reference/name.
    const retry = await scopes.run<ActionReport>(withFlags(args, ['--force']), scope);
    if (!retry.ok) {
      reportGrimFailure(retry, output, `grim ${args[0]}`);
    }
  });
  return true;
}

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
  // positionalOf, not args[1]: the builders put their positionals behind a `--`.
  const name = artifactName(refRepo(positionalOf(args)));
  // `grim install` is the one builder with no `--` and no positional, so
  // positionalOf returns '' for it and the notice below rendered an empty pair
  // of backticks. A scope-wide command has no artifact to name — say so.
  const subject = positionalOf(args) === '' ? `the ${scope} scope` : `\`${name}\``;
  // Normalized, not `===`: a case/whitespace variant of this reason arriving
  // together with forceable:true must still take the security branch below,
  // never the override branch — see CWE-697/CWE-20 in the anchor-escape ADR.
  if (result.reason?.trim().toLowerCase() === 'anchor-escape') {
    const choice = await vscode.window.showErrorMessage(
      `Grimoire: ${subject}: a recorded path resolves outside its anchor root. grim will not ` +
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
      result.message +
      (args[0] === 'update' ? FORCE_UPDATE_NOTE : '');
    if (await confirmOverwrite(name, detail, args, scope, scopes, output)) {
      await onDone();
    }
    return true;
  }
  return false;
}

/**
 * The ok-result twin of {@link offerForcedRetry}: grim ≥ 0.13.0 reports a
 * refused `grim update` as a NORMAL report (exit 65, `refused` on the row), so
 * the refusal never reaches the failure path at all. Hosts call this
 * unconditionally on any ok action report — it returns false when the report
 * carries no refusal, and true once it has shown the confirm.
 *
 * Deliberately takes NO `onDone`. offerForcedRetry owes its own refresh because
 * it returns early to skip `reportGrimFailure`; here the host's trailing refresh
 * always runs, so a confirmed retry gets one refresh rather than two — and a
 * DECLINED one still repaints the pin that rolled forward regardless.
 *
 * `args[0]` is gated to `update` even though only update reports carry
 * `refused`: the confirm reissues the argv with `--force`, and that flag is not
 * universal. A SCOPE-WIDE update (no positional) is declined outright for the
 * reason updateRefusal.ts exists — forcing it would discard the user's edits to
 * every other modified artifact in the scope, irreversibly, on a dialog that
 * named one. Update All routes there instead.
 */
export async function offerRefusedRetry(
  value: unknown,
  args: string[],
  scope: Scope,
  scopes: ScopeService,
  output: vscode.OutputChannel,
): Promise<boolean> {
  const refused = refusedNames(value);
  if (refused.length === 0 || args[0] !== 'update' || positionalOf(args) === '') {
    return false;
  }
  // Normally one row: these hosts update a single artifact. Joined rather than
  // truncated, since the retry below forces every one of them.
  const names = refused.join(', ');
  const detail =
    `grim kept your local changes to \`${names}\` and did not replace those files. ` +
    `Everything else updated, and the lock pin moved on — so the artifact reads as up to ` +
    `date while its files are still yours.\n\nOverwriting discards those local changes. ` +
    `This cannot be undone.` +
    FORCE_UPDATE_NOTE;
  await confirmOverwrite(names, detail, args, scope, scopes, output);
  return true;
}
