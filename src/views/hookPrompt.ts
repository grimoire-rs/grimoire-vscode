// One-time project prompts for experimental hooks. grim keeps a declared hook
// inert until two project gates clear — the `[options.experimental] hooks` flag
// and this workspace's consent record — and reports which one holds it as an
// `arming[].cause` on the hook's status row. This offers each gate once:
// "Enable" / "Allow" runs the grim command that clears it (grim then owns the
// yes: the flag lives in grimoire.toml, consent in its own record), "No" is
// remembered per workspace and never asked again. Dismissing is not a "No".
import * as vscode from 'vscode';
import {
  configSetArgs,
  hookAllowArgs,
  installArgs,
  type ActionReport,
} from '../grim';
import { declinedKey, hookPromptFor, type HookGate } from '../gatePrompt';
import { reportGrimFailure, runWithStatusProgress } from '../notify';
import type { ScopeService, ScopeSnapshot } from '../scopes';
import { offerLock } from './staleLock';

export class HookPrompter {
  /** Gates already offered this session — a refresh lands every few seconds,
   *  and a dismissed toast must not come straight back. */
  private readonly offered = new Set<HookGate>();

  constructor(
    private readonly scopes: ScopeService,
    private readonly workspaceState: vscode.Memento,
    private readonly output: vscode.OutputChannel,
    private readonly onDone: () => Promise<void>,
  ) {}

  async offer(project: ScopeSnapshot | undefined): Promise<void> {
    // A restricted-mode window must not be one click away from running a
    // cloned repository's hooks.
    if (!vscode.workspace.isTrusted) {
      return;
    }
    const prompt = hookPromptFor(project?.status);
    if (
      !project ||
      !prompt ||
      this.offered.has(prompt.gate) ||
      this.workspaceState.get(declinedKey(prompt.gate)) === true
    ) {
      return;
    }
    this.offered.add(prompt.gate);
    const names = prompt.hooks.join(', ');
    const [message, yes, steps, title] =
      prompt.gate === 'enable'
        ? [
            `Grimoire: This project declares experimental hooks (${names}). ` +
              'Enable hooks for this project? This sets options.experimental.hooks in grimoire.toml.',
            'Enable',
            [configSetArgs('options.experimental.hooks', 'true'), installArgs()],
            'Enabling hooks',
          ]
        : [
            `Grimoire: This workspace declares hooks (${names}) that run commands on ` +
              "your agents' tool calls. Allow them to run?",
            'Allow',
            [hookAllowArgs(), installArgs()],
            'Allowing hooks',
          ];
    const choice = await vscode.window.showWarningMessage(message, yes, 'No');
    if (choice === 'No') {
      await this.workspaceState.update(declinedKey(prompt.gate), true);
      return;
    }
    if (choice !== yes) {
      return;
    }
    await runWithStatusProgress(title, async () => {
      for (const args of steps) {
        const result = await this.scopes.run<ActionReport>(args, 'project');
        if (!result.ok) {
          if (!offerLock(result, args, 'project', this.scopes, this.output, this.onDone)) {
            reportGrimFailure(result, this.output, `grim ${args[0]}`);
          }
          return;
        }
      }
    });
    await this.onDone();
  }
}
