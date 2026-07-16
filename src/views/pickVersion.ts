// Shared "Install specific version…" flow for both hosts (sidebar cards and
// the details header). Picks a tag — from `grim describe`, falling back to
// manual entry when no tag list is available — then a scope, then runs
// `grim add <repo>:<tag>`, which pins/downgrades the artifact.
import * as vscode from 'vscode';
import {
  addArgs,
  describeArgs,
  initArgs,
  type ActionReport,
  type DescribeResult,
  type Scope,
} from '../grim';
import { notifyError, runWithStatusProgress } from '../notify';
import type { ScopeService } from '../scopes';
import { artifactName, refRepo } from '../webview/model';

export async function pickVersion(
  repo: string,
  scopes: ScopeService,
  output: vscode.OutputChannel,
  onDone: () => Promise<void>,
  /** Scope preselected by a details scope row (item 2): skips the scope QuickPick. */
  preselectedScope?: Scope,
): Promise<void> {
  const describe = await scopes.run<DescribeResult>(describeArgs(repo), 'global');
  const tags = describe.ok ? describe.value.tags : [];
  const tag =
    tags.length > 0
      ? await vscode.window.showQuickPick(tags, { placeHolder: 'Select version to install' })
      : await vscode.window.showInputBox({
          prompt: 'Tag to install, e.g. 1.4.2',
          placeHolder: '1.4.2',
        });
  if (!tag) {
    return;
  }
  const scope = preselectedScope ?? (await pickScope(scopes));
  if (!scope) {
    return;
  }
  await runWithStatusProgress(`Installing ${artifactName(repo)}:${tag}`, async () => {
    // A preselected project scope may still lack grimoire.toml; `grim add`
    // there errors before any network, so create the config first (item 1).
    // projectNeedsInit (not !projectConfigured): a FAILED probe must not
    // trigger init — see the method's doc.
    if (scope === 'project' && (await scopes.projectNeedsInit())) {
      const init = await scopes.run<ActionReport>(initArgs(), 'project');
      if (!init.ok) {
        const message = init.kind === 'not-found' ? 'grim executable not found' : init.message;
        output.appendLine(`error: ${message}`);
        notifyError(`Grimoire: ${message}`);
        return;
      }
    }
    // refRepo strips any tag on the incoming repo (deep links can arrive
    // tagged) so we pin a single tag, never repo:1.5.0:1.4.2.
    const result = await scopes.run<ActionReport>(addArgs(`${refRepo(repo)}:${tag}`), scope);
    if (!result.ok) {
      const message = result.kind === 'not-found' ? 'grim executable not found' : result.message;
      output.appendLine(`error: ${message}`);
      notifyError(`Grimoire: ${message}`);
    }
  });
  await onDone();
}

/** Prompts for scope only when project scope is configured; otherwise global. */
async function pickScope(scopes: ScopeService): Promise<Scope | undefined> {
  if (!(await scopes.projectConfigured())) {
    return 'global';
  }
  const projectName = scopes.projectFolder()?.split(/[\\/]/).pop() ?? 'project';
  const choice = await vscode.window.showQuickPick(
    [
      { label: `Project — ${projectName}`, scope: 'project' as Scope },
      { label: 'Global', scope: 'global' as Scope },
    ],
    { placeHolder: 'Install into which scope?' },
  );
  return choice?.scope;
}
