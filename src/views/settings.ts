// Settings editor tab: one singleton WebviewPanel, revealed on reopen. State
// is always refetched from grim (no host-side cache) — same "no retained
// state across a hide" philosophy as the details manager, minus the
// per-repo bookkeeping (there is exactly one of these).
import * as vscode from 'vscode';
import {
  configListArgs,
  configSetArgs,
  configUnsetArgs,
  contextArgs,
  initArgs,
  isRetryable,
  registryAddArgs,
  registryFieldsArgs,
  registryListArgs,
  registryRmArgs,
  registryUseArgs,
  type ActionReport,
  type ConfigEntry,
  type ConfigWriteResult,
  type ContextInfo,
  type ItemsEnvelope,
  type RegistryEntry,
  type RegistryFieldEntry,
  type Scope,
} from '../grim';
import { isProjectNotDiscovered, type ScopeService } from '../scopes';
import { buildSettingsVM, resolveSettingsPhase, type SettingsSource } from '../webview/settings/model';
import type {
  HostToSettings,
  SettingsRegistryFieldVM,
  SettingsState,
  SettingsToHost,
} from '../webview/protocol';
import { notifyError } from '../notify';
import { webviewHtml } from './html';

export const SETTINGS_VIEW_TYPE = 'grimoire.settings';

/** Lock-contention retry (grim exit 75): one retry after a short backoff, per
 *  the spec — a config write racing another grim process is expected to be
 *  transient, not worth a full queue/backoff policy. */
const LOCK_RETRY_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SettingsManager {
  private panel: vscode.WebviewPanel | undefined;
  // Panels disposed mid-fetch: a write/refresh can await grim for a while, and
  // touching panel.webview after disposal throws — same guard DetailsManager
  // uses. An untracked panel (never seen by open(), e.g. a test double) is
  // simply never in here, so posting to it "just works" (test seam).
  private disposedPanels = new WeakSet<vscode.WebviewPanel>();
  /** The scope the panel is currently showing (last 'ready'/'switchScope' from
   *  the webview) — external-refresh reposts target this, and a write whose
   *  scope has since been navigated away from is dropped rather than posted
   *  (the webview already reset its local state on switch, so there is
   *  nothing left there to reconcile it against). */
  private activeScope: Scope | undefined;
  /** One in-flight write per scope, chained so a second edit to the same scope
   *  waits for the first's grim round trip instead of racing it. */
  private writeChains = new Map<Scope, Promise<void>>();
  /** grim's registry-form field metadata (`config registry fields`) —
   *  context-free, so fetched ONCE per panel lifetime rather than per scope;
   *  see ensureRegistryFields. Cached as the in-flight PROMISE (not just its
   *  resolved value) so a second caller awaiting it while the fetch is still
   *  running never triggers a second grim spawn. */
  private registryFieldsPromise: Promise<SettingsRegistryFieldVM[]> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly scopes: ScopeService,
    private readonly output: vscode.OutputChannel,
    /** Re-runs the sidebar/details refresh — a Settings write can change what
     *  those views show (e.g. show_deprecated, a new default registry).
     *  Deliberately NOT wired to also refresh this Settings panel itself in
     *  production (extension.ts's refreshSidebarAndDetails, not the full
     *  refreshAll) — writeInner/initScope below already repost this
     *  panel's own state explicitly once grim confirms; refreshing it again
     *  here would double every `config list`/`registry list` round trip. */
    private readonly onDidChange: () => Promise<void>,
    /** Reuses the sidebar's install-grim flow (confirm prompt + install). */
    private readonly installGrimAction: () => Promise<void>,
    /** Suspends file watchers around a mutating action (its own writes' events
     *  are redundant with that write's own state repost). */
    private readonly suspendWhile: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    // Kicks off the one-shot registry-fields fetch the instant the panel is
    // created, so it's already in flight (often already resolved) by the
    // time the webview's 'ready' message asks buildState for it.
    void this.ensureRegistryFields();
    const panel = vscode.window.createWebviewPanel(
      SETTINGS_VIEW_TYPE,
      'Grimoire Settings',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo.png');
    this.panel = panel;
    panel.onDidDispose(() => {
      this.disposedPanels.add(panel);
      if (this.panel === panel) {
        this.panel = undefined;
        this.activeScope = undefined;
      }
    });
    panel.webview.onDidReceiveMessage((message: SettingsToHost) => {
      void this.onMessage(panel, message);
    });
    const projectOpen = this.scopes.projectFolder() !== undefined;
    // No SSR skeleton for this bundle — sidebar-style empty body;
    // the webview posts 'ready' once booted and paints from the first 'state'.
    panel.webview.html = webviewHtml(
      panel.webview,
      this.extensionUri,
      'settings',
      `data-project-open="${projectOpen}"`,
    );
  }

  /** Reposts fresh state to the panel's currently active scope, when open —
   *  the shared refreshAll's hook for watcher-driven / post-action refreshes. */
  async refreshOpenPanel(): Promise<void> {
    if (this.panel && this.activeScope) {
      await this.postState(this.panel, this.activeScope);
    }
  }

  /** Public for tests: the webview message entry point. */
  async onMessage(panel: vscode.WebviewPanel, message: SettingsToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
      case 'switchScope':
        await this.postState(panel, message.scope);
        return;
      case 'setValue':
        await this.write(
          panel,
          message.scope,
          message.key,
          configSetArgs(message.key, message.value),
        );
        return;
      case 'unsetValue':
        await this.write(panel, message.scope, message.key, configUnsetArgs(message.key));
        return;
      case 'addRegistry':
        await this.write(
          panel,
          message.scope,
          message.alias,
          registryAddArgs(message.alias, message.locator, { default: message.default }),
        );
        return;
      case 'removeRegistry':
        await this.write(panel, message.scope, message.alias, registryRmArgs(message.alias));
        return;
      case 'useRegistry':
        await this.write(panel, message.scope, message.alias, registryUseArgs(message.alias));
        return;
      case 'initProject':
        await this.initScope(panel, 'project');
        return;
      case 'initGlobal':
        await this.initScope(panel, 'global');
        return;
      case 'openConfigFile':
        await this.openConfigFile(message.scope);
        return;
      case 'openVsCodeSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'grimoire');
        return;
      case 'openExternal':
        if (/^https?:/.test(message.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        return;
      case 'installGrim':
        await this.installGrimAction();
        await this.postState(panel, this.activeScope ?? 'global');
        return;
    }
  }

  private post(panel: vscode.WebviewPanel, message: HostToSettings): void {
    if (this.disposedPanels.has(panel)) {
      return; // disposed while this async op was in flight — touching it throws
    }
    void panel.webview.postMessage(message);
  }

  private async postState(panel: vscode.WebviewPanel, scope: Scope): Promise<void> {
    this.activeScope = scope;
    const state = await this.buildState(scope);
    // A later switchScope/ready may have superseded this fetch while it awaited.
    if (this.activeScope === scope) {
      this.post(panel, { type: 'state', state });
    }
  }

  /** Fetches grim's registry-form field metadata exactly once per panel
   *  lifetime, memoized on the promise itself (not the resolved value) so a
   *  concurrent caller awaits the SAME in-flight grim spawn instead of
   *  starting a second one. Context-free command — 'global' is only a
   *  scope ScopeService.run requires structurally, it never affects this
   *  call's output. Any failure (grim missing, older grim predating this
   *  subcommand, a transient error) falls back to `[]` silently: render.ts's
   *  hardcoded labels/tooltips cover the whole form on their own, so a failed
   *  fetch here is never surfaced as an error (spec: no error surfaced). */
  private ensureRegistryFields(): Promise<SettingsRegistryFieldVM[]> {
    if (!this.registryFieldsPromise) {
      this.registryFieldsPromise = this.scopes
        .run<ItemsEnvelope<RegistryFieldEntry>>(registryFieldsArgs(), 'global')
        .then((result) =>
          result.ok
            ? result.value.items.map((f) => ({ key: f.key, title: f.title, description: f.description }))
            : [],
        );
    }
    return this.registryFieldsPromise;
  }

  /** One scope's fetch → SettingsState. 'loading' is never constructed here —
   *  the webview shows its own loading UI between switchScope and this post
   *  (same split as SidebarState). 'error'/'no-grim' are host-built literals
   *  that skip buildSettingsVM entirely; 'ready'/'no-folder'/
   *  'project-no-toml'/'global-no-toml' all go through it (model.ts owns that
   *  phase resolution). */
  private async buildState(scope: Scope): Promise<SettingsState> {
    // Context-free and scope-independent — computed once up front so every
    // branch below (including the early-return empty/error states) threads
    // the SAME value through, rather than re-deriving per branch.
    const registryFields = await this.ensureRegistryFields();
    const folder = this.scopes.projectFolder();
    const projectOpen = folder !== undefined;
    const projectName = folder ? (folder.split(/[\\/]/).pop() ?? null) : null;
    const scopesVM = { projectOpen, projectConfigured: false, projectName };
    if (scope === 'project' && !projectOpen) {
      // No workspace folder: `grim context` has no project cwd to discover
      // from — skip the round trip entirely rather than run it against the
      // extension host's own cwd.
      return buildSettingsVM({
        scope,
        scopes: scopesVM,
        grimMissing: false,
        configPath: null,
        configExists: false,
        entries: [],
        registries: [],
        registryFields,
      });
    }
    const ctx = await this.scopes.run<ContextInfo>(contextArgs(), scope);
    if (!ctx.ok) {
      if (ctx.kind === 'not-found') {
        return buildSettingsVM({
          scope,
          scopes: scopesVM,
          grimMissing: true,
          configPath: null,
          configExists: false,
          entries: [],
          registries: [],
          registryFields,
        });
      }
      // Project scope's `context` FAILS outright (NotDiscovered, code
      // "not-found", exit 79) when no grimoire.toml exists anywhere up the
      // directory tree — it never succeeds with config_exists:false (verified
      // live against grim 0.9.0; see isProjectNotDiscovered). Route that
      // ordinary case through the same configExists:false path as every other
      // empty/init state, so it renders 'project-no-toml' instead of leaking
      // grim's raw error message through the generic 'error' phase.
      if (scope === 'project' && isProjectNotDiscovered(ctx)) {
        return buildSettingsVM({
          scope,
          scopes: scopesVM,
          grimMissing: false,
          configPath: null,
          configExists: false,
          entries: [],
          registries: [],
          registryFields,
        });
      }
      return {
        scope,
        phase: 'error',
        projectOpen,
        projectName,
        configPath: null,
        rawConfigPath: null,
        groups: [],
        registries: [],
        registryFields,
        error: ctx.message,
      };
    }
    const configExists = ctx.value.config_exists;
    // Reuses model.ts's own phase decision — never re-derived — so "should I
    // skip config list/registry list" can't drift from "is this scope's
    // empty/init state". BOTH scopes gate on configExists (spec §2,
    // user-decided 2026-07-17: no auto-materializing reads before the user
    // clicks Initialize): an unconfigured project 404s on those calls (exit
    // 79); an unconfigured global would otherwise silently list in-memory
    // defaults as a fully "ready" form — no different from the panel writing
    // the very first control edit against a config that never existed.
    if (resolveSettingsPhase({ scope, scopes: scopesVM, grimMissing: false, configExists }) !== 'ready') {
      return buildSettingsVM({
        scope,
        scopes: { ...scopesVM, projectConfigured: false },
        grimMissing: false,
        configPath: ctx.value.config_path,
        configExists,
        entries: [],
        registries: [],
        registryFields,
      });
    }
    const [list, registries] = await Promise.all([
      this.scopes.run<ItemsEnvelope<ConfigEntry>>(configListArgs({ all: true }), scope),
      this.scopes.run<ItemsEnvelope<RegistryEntry>>(registryListArgs(), scope),
    ]);
    const errorState = (message: string): SettingsState => ({
      scope,
      phase: 'error',
      projectOpen,
      projectName,
      configPath: ctx.value.config_path,
      rawConfigPath: ctx.value.config_path,
      groups: [],
      registries: [],
      registryFields,
      error: message,
    });
    if (!list.ok) {
      return errorState(list.kind === 'not-found' ? 'grim executable not found' : list.message);
    }
    if (!registries.ok) {
      return errorState(
        registries.kind === 'not-found' ? 'grim executable not found' : registries.message,
      );
    }
    const source: SettingsSource = {
      scope,
      scopes: { ...scopesVM, projectConfigured: configExists },
      grimMissing: false,
      configPath: ctx.value.config_path,
      configExists,
      entries: list.value.items,
      registries: registries.value.items,
      registryFields,
    };
    return buildSettingsVM(source);
  }

  /** Runs one grim write for `scope`, chained after any write already in
   *  flight for that same scope. Every write is wrapped in suspendWhile (its
   *  own watcher events are redundant with the state repost it ends in), and
   *  a retryable failure (see isRetryable — lock contention, exit 75) gets
   *  one retry after a short delay. Success re-fetches + reposts state via
   *  repostAfterChange (a single
   *  fetch, see its own doc); failure posts writeError only — nothing was
   *  written, so no state repost follows (protocol contract, stage 2
   *  handoff). */
  private async write(
    panel: vscode.WebviewPanel,
    scope: Scope,
    key: string,
    args: string[],
  ): Promise<void> {
    const prior = this.writeChains.get(scope) ?? Promise.resolve();
    const run = prior.then(
      () => this.writeInner(panel, scope, key, args),
      () => this.writeInner(panel, scope, key, args),
    );
    this.writeChains.set(scope, run);
    await run;
  }

  private async writeInner(
    panel: vscode.WebviewPanel,
    scope: Scope,
    key: string,
    args: string[],
  ): Promise<void> {
    await this.suspendWhile(async () => {
      let result = await this.scopes.run<ConfigWriteResult>(args, scope);
      if (!result.ok && result.kind === 'error' && isRetryable(result)) {
        await sleep(LOCK_RETRY_DELAY_MS);
        result = await this.scopes.run<ConfigWriteResult>(args, scope);
      }
      if (!result.ok) {
        const message = result.kind === 'not-found' ? 'grim executable not found' : result.message;
        this.output.appendLine(`error: grim ${args.join(' ')}: ${message}`);
        this.post(panel, { type: 'writeError', scope, key, message });
        return;
      }
      await this.repostAfterChange(panel, scope);
    });
  }

  /** Runs `grim init` for `scope`, ONLY in response to the button click
   *  (initProject/initGlobal messages) — never on open/switchScope, per spec
   *  §2's 2026-07-17 decision. Shared between both scopes rather than two
   *  near-identical methods. */
  private async initScope(panel: vscode.WebviewPanel, scope: Scope): Promise<void> {
    await this.suspendWhile(async () => {
      const result = await this.scopes.run<ActionReport>(initArgs(), scope);
      if (!result.ok) {
        const message = result.kind === 'not-found' ? 'grim executable not found' : result.message;
        notifyError(`Grimoire: ${message}`);
      } else {
        void vscode.window.showInformationMessage(
          scope === 'project' ? 'Created grimoire.toml' : 'Created global grimoire.toml',
        );
      }
      await this.repostAfterChange(panel, scope);
    });
  }

  /** Shared tail of writeInner/initScope: runs onDidChange (sidebar +
   *  details, per the constructor doc — NOT this panel, in production) then
   *  reposts THIS panel's own state exactly once. The explicit repost here
   *  (rather than leaning on onDidChange to cover it, the way sidebar's own
   *  post-action refresh does for itself) is what lets an UNTRACKED panel —
   *  the test-double convention settingsHost.test.ts uses instead of calling
   *  open() — still get its repost even though onDidChange there is a no-op
   *  or targets a different manager. Drops a stale-scope repost: the user
   *  switched tabs while the action was in flight, and switching already
   *  reset that scope's local UI state. */
  private async repostAfterChange(panel: vscode.WebviewPanel, scope: Scope): Promise<void> {
    await this.onDidChange();
    if (this.activeScope === scope) {
      await this.postState(panel, scope);
    }
  }

  private async openConfigFile(scope: Scope): Promise<void> {
    if (scope === 'project' && !this.scopes.projectFolder()) {
      notifyError('Grimoire: open a folder to configure project scope.');
      return;
    }
    const ctx = await this.scopes.run<ContextInfo>(contextArgs(), scope);
    if (!ctx.ok) {
      // Same NotDiscovered case as buildState() above: project's probe fails
      // outright rather than succeeding with config_exists:false, but the
      // user-facing message should read exactly like the ordinary
      // "doesn't exist yet" case below, not grim's raw error text.
      if (scope === 'project' && isProjectNotDiscovered(ctx)) {
        notifyError('Grimoire: grimoire.toml does not exist yet.');
        return;
      }
      notifyError(
        `Grimoire: ${ctx.kind === 'not-found' ? 'grim executable not found' : ctx.message}`,
      );
      return;
    }
    if (!ctx.value.config_exists) {
      notifyError(
        `Grimoire: ${scope === 'project' ? 'grimoire.toml' : 'the global config'} does not exist yet.`,
      );
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ctx.value.config_path));
      await vscode.window.showTextDocument(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyError(`Grimoire: could not open ${ctx.value.config_path}: ${message}`);
    }
  }
}
