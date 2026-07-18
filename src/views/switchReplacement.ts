// One-click "switch to replacement" for a deprecated but still-installed
// artifact, shared by both action hosts (sidebar card menu and details
// deprecation banner). grim's catalog names a fully-qualified, publish-validated
// successor (`replaced_by`); switching installs it in each scope the old
// artifact occupies (`grim add <replacedBy>`), then removes the old one
// (`grim uninstall|remove`). It uninstalls, so it confirms with a modal first.
import * as vscode from 'vscode';
import {
  addArgs,
  isRetryable,
  uninstallOrRemoveArgs,
  type ActionReport,
  type GrimResult,
  type Scope,
} from '../grim';
import { notifyError, runWithStatusProgress } from '../notify';
import type { ScopeService } from '../scopes';

/** One installed scope of the old artifact to switch. `kind`/`name` are the
 *  grim-authoritative install identity (bundles route through `remove`). */
export interface SwitchTarget {
  scope: Scope;
  kind: string;
  name: string;
}

const SCOPE_LABEL: Record<Scope, string> = { project: 'Project', global: 'Global' };

/** Runs one grim call, retrying it once when the failure is a transient lock
 *  (isRetryable — grim reason:"locked", or exit 75 on older builds). */
async function runRetrying(
  scopes: ScopeService,
  args: string[],
  scope: Scope,
): Promise<GrimResult<ActionReport>> {
  const first = await scopes.run<ActionReport>(args, scope);
  if (!first.ok && first.kind === 'error' && isRetryable(first)) {
    return scopes.run<ActionReport>(args, scope);
  }
  return first;
}

/**
 * Confirms, then for each installed scope sequentially installs the replacement
 * and removes the old artifact, under a watcher suspension. Failure handling:
 *  - add fails → abort, nothing torn down (exit 64 name-collision — grim
 *    refuses a same-name-different-id declare — gets a distinct
 *    "resolve manually" message);
 *  - add ok + remove fails → honest partial toast (the replacement is in, the
 *    old must be removed by hand);
 *  - lock contention → one retry per call (isRetryable).
 * Always refreshes (`onDone`) afterwards. A declined modal runs nothing (and
 * never suspends watchers — the confirm is before the suspension).
 */
export async function switchToReplacement(params: {
  scopes: ScopeService;
  targets: SwitchTarget[];
  replacedBy: string;
  output: vscode.OutputChannel;
  suspendWhile: <T>(fn: () => Promise<T>) => Promise<T>;
  onDone: () => Promise<void>;
}): Promise<void> {
  const { scopes, targets, replacedBy, output, suspendWhile, onDone } = params;
  const first = targets[0];
  if (!first) {
    return;
  }
  const oldName = first.name;
  const scopeText = targets.map((t) => SCOPE_LABEL[t.scope]).join(' and ');
  const choice = await vscode.window.showWarningMessage(
    `Switch ${oldName} to its replacement ${replacedBy} in ${scopeText}? This installs ` +
      `${replacedBy} and uninstalls ${oldName}.`,
    { modal: true },
    'Switch',
  );
  if (choice !== 'Switch') {
    return;
  }
  await suspendWhile(() =>
    runWithStatusProgress(`Switching ${oldName} to ${replacedBy}`, async () => {
      for (const target of targets) {
        const added = await runRetrying(scopes, addArgs(replacedBy), target.scope);
        if (!added.ok) {
          const message = added.kind === 'not-found' ? 'grim executable not found' : added.message;
          output.appendLine(`error: ${message}`);
          const collision = added.kind === 'error' && added.exitCode === 64;
          notifyError(
            collision
              ? `Grimoire: cannot switch ${oldName} to ${replacedBy} — an artifact with that ` +
                  `name is already installed under a different source. Resolve it manually.`
              : `Grimoire: grim add: ${message}`,
          );
          return; // abort — nothing torn down
        }
        const removed = await runRetrying(
          scopes,
          uninstallOrRemoveArgs(target.kind, target.name),
          target.scope,
        );
        if (!removed.ok) {
          const message =
            removed.kind === 'not-found' ? 'grim executable not found' : removed.message;
          output.appendLine(`error: ${message}`);
          notifyError(
            `Grimoire: installed ${replacedBy} but could not remove ${oldName} — remove it manually.`,
          );
          return;
        }
      }
    }),
  );
  await onDone();
}
