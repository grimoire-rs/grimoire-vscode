// Project prompts for experimental hooks and settings. grim keeps a declared
// hook or settings package inert until two gates clear: its `[options.experimental]`
// flag and this workspace's consent record. Each gate is asked at most once per
// session for each kind it holds back, one toast at a time, and only in a
// trusted workspace. "Enable" / "Allow" runs the grim command that clears it;
// "No" is remembered per workspace for each kind the gate holds back, so a kind
// the consent prompt only names is still asked once consent holds it. Dismissing
// the toast is not a "No". "Allow" first re-reads the status and, when Allow
// would now cover a package the prompt did not name, or the status cannot be
// read, records nothing and lets the consent gate be asked again. A failed
// `grim hook allow` or install lets it be asked again too.
import * as vscode from 'vscode';
import {
  dialogText,
  statusArgs,
  type ActionReport,
  type StatusEnvelope,
  type StatusItem,
} from '../grim';
import {
  declinedKey,
  gatePromptText,
  hookPromptFor,
  newlyCovered,
  promptNamesLine,
  type GatePrompt,
} from '../gatePrompt';
import { reportGrimFailure, runWithStatusProgress } from '../notify';
import type { ScopeService, ScopeSnapshot } from '../scopes';
import { offerLock } from './staleLock';

export class HookPrompter {
  /** Gate and kind pairs (by declinedKey) already offered this session — a
   *  refresh lands every few seconds, and a dismissed toast must not come
   *  straight back. Per kind, so a package of the other kind that turns up
   *  later still gets its prompt. */
  private readonly offered = new Set<string>();
  /** True while a toast or its grim steps are pending, so a refresh cannot
   *  stack a second gate's toast on it or run grim beside it. */
  private busy = false;
  /** The newest project snapshot offered, so the next gate can follow an
   *  answer without waiting for a refresh. */
  private latest: ScopeSnapshot | undefined;

  constructor(
    private readonly scopes: ScopeService,
    private readonly workspaceState: vscode.Memento,
    private readonly output: vscode.OutputChannel,
    private readonly onDone: () => Promise<void>,
  ) {}

  async offer(project: ScopeSnapshot | undefined): Promise<void> {
    this.latest = project;
    // A restricted-mode window must not be one click away from running a
    // cloned repository's hooks.
    if (!vscode.workspace.isTrusted || this.busy) {
      return;
    }
    const prompt = hookPromptFor(project?.status, (gate, kind) => {
      const key = declinedKey(gate, kind);
      return this.offered.has(key) || this.workspaceState.get(key) === true;
    });
    if (!project || !prompt) {
      return;
    }
    for (const kind of prompt.held ?? prompt.kinds) {
      this.offered.add(declinedKey(prompt.gate, kind));
    }
    this.busy = true;
    let ran: boolean;
    try {
      ran = await this.ask(prompt, project.status ?? []);
    } finally {
      this.busy = false;
    }
    if (ran) {
      // The refresh it triggers offers the next gate.
      await this.onDone();
    } else {
      await this.offer(this.latest);
    }
  }

  /** Shows the toast and, on yes, runs its grim steps. False only for a
   *  dismissal or a "No"; any other answer needs a refresh. */
  private async ask(prompt: GatePrompt, shown: readonly StatusItem[]): Promise<boolean> {
    const { message, yes, steps, title } = gatePromptText(prompt);
    const namesLine = promptNamesLine(prompt);
    if (namesLine !== undefined) {
      this.output.appendLine(namesLine);
    }
    const choice = await vscode.window.showWarningMessage(message, yes, 'No');
    if (choice === 'No') {
      for (const kind of prompt.held ?? prompt.kinds) {
        await this.workspaceState.update(declinedKey(prompt.gate, kind), true);
      }
      return false;
    }
    if (choice !== yes) {
      return false;
    }
    let failed = false;
    let unnamed: string[] = [];
    await runWithStatusProgress(title, async () => {
      if (prompt.gate === 'consent') {
        // The toast can stay open for a long time, and `grim hook allow`
        // consents to whatever the lock pins when it runs.
        const now = await this.scopes.run<StatusEnvelope>(statusArgs(), 'project');
        if (!now.ok) {
          failed = true;
          reportGrimFailure(now, this.output, 'grim status');
          return;
        }
        const covered = newlyCovered(shown, now.value.items);
        if (covered === null) {
          failed = true;
          this.output.appendLine(
            'Grimoire: consent not recorded; grim status did not report its rows, ' +
              'so the prompt asks again.',
          );
          return;
        }
        unnamed = covered;
        if (unnamed.length > 0) {
          return;
        }
      }
      for (const args of steps) {
        const result = await this.scopes.run<ActionReport>(args, 'project');
        if (!result.ok) {
          failed = true;
          if (!offerLock(result, args, 'project', this.scopes, this.output, this.onDone)) {
            reportGrimFailure(result, this.output, `grim ${args[0]}`);
          }
          return;
        }
      }
    });
    if (unnamed.length > 0) {
      this.output.appendLine(
        `Grimoire: consent not recorded; Allow would now also cover ` +
          `${unnamed.map((n) => dialogText(n, 200)).join(', ')}, so the prompt asks again.`,
      );
    }
    if (prompt.gate === 'consent' && (failed || unnamed.length > 0)) {
      // No consent was recorded, or the install after it failed, so a later
      // refresh may ask again; each repeat waits for another answer.
      for (const kind of prompt.held ?? prompt.kinds) {
        this.offered.delete(declinedKey(prompt.gate, kind));
      }
    }
    return true;
  }
}
