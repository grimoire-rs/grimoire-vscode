import * as vscode from 'vscode';
import { CatalogService } from './catalog';
import { readConfig } from './config';
import {
  addArgs,
  contextArgs,
  initArgs,
  updateArgs,
  type ActionReport,
  type ContextInfo,
  type GrimResult,
  type Scope,
} from './grim';
import { installGrim } from './installer';
import { initNotify, notifyError, runWithStatusProgress } from './notify';
import { Prefetcher } from './prefetch';
import { ScopeService } from './scopes';
import { DetailsManager, DETAILS_VIEW_TYPE } from './views/details';
import { pickVersion } from './views/pickVersion';
import { SidebarProvider } from './views/sidebar';
import { Watchers } from './watchers';
import { artifactName, isValidRepo, parseShareLink, refRepo } from './webview/model';

export interface GrimoireApi {
  refresh(): Promise<void>;
  scopes: ScopeService;
  /** Test seams — not part of the public surface. */
  providers: {
    sidebar: SidebarProvider;
    details: DetailsManager;
  };
  /** Deep-link handler (test seam; fired for real via registerUriHandler). */
  handleUri(uri: vscode.Uri): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): GrimoireApi {
  const output = vscode.window.createOutputChannel('Grimoire', { log: true });
  context.subscriptions.push(output);
  initNotify(context);

  const scopes = new ScopeService(context.globalStorageUri, output);
  scopes.logExecutable();
  const catalog = new CatalogService(scopes);

  const refreshAll = async (): Promise<void> => {
    // One snapshot feeds the sidebar (installs live in it) and the open details
    // panels; the sidebar's single refresh computes both tab card sets.
    const snap = await scopes.snapshot();
    await Promise.all([sidebar.refresh({}, snap), details.refreshOpenPanels()]);
  };

  const offerInstallGrim = async (): Promise<void> => {
    const choice = await vscode.window.showInformationMessage(
      'The grim CLI was not found. Install the latest release from GitHub?',
      'Install grim',
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      void vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'grimoire.path.executable',
      );
      return;
    }
    if (choice !== 'Install grim') {
      return;
    }
    await runInstallGrim();
  };

  const runInstallGrim = async (): Promise<void> => {
    try {
      const target = await runWithStatusProgress('Installing grim', () =>
        installGrim(context.globalStorageUri.fsPath, {
          report: (message) => output.appendLine(message),
        }),
      );
      output.appendLine(`installed grim at ${target}`);
      void vscode.window.showInformationMessage(`grim installed at ${target}`);
      await refreshAll();
      await rebuildWatchers();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`grim install failed: ${message}`);
      notifyError(
        `Installing grim failed: ${message}. See https://grimoire.rs for manual installation.`,
      );
    }
  };

  const pin = async (ref: string): Promise<void> => {
    const tag = await vscode.window.showInputBox({
      prompt: `Pin ${ref} to an exact tag`,
      placeHolder: 'e.g. 1.4.2',
    });
    if (!tag) {
      return;
    }
    // Honor grimoire.defaultScope, but fall back to global when project scope has
    // no grimoire.toml (else the install fails). refRepo strips any tag the ref
    // already carries so we don't build repo:1.5.0:1.4.2.
    const scope: Scope =
      readConfig().defaultScope === 'project' && (await scopes.projectConfigured())
        ? 'project'
        : 'global';
    await suspendWhile(async () => {
      const result = await scopes.run<ActionReport>(addArgs(`${refRepo(ref)}:${tag}`), scope);
      if (!result.ok) {
        const message =
          result.kind === 'not-found' ? 'grim executable not found' : result.message;
        notifyError(`Grimoire: ${message}`);
      }
      await refreshAll();
    });
  };

  // Focuses the sidebar's Browse tab and seeds its search box — the shared
  // path behind the /open deep link and the details rail tag click (item 2).
  // focusSearch flips the webview to the Browse tab. `sidebar` is declared
  // below; this thunk only reads it at call time (runtime), never at
  // activation, so the forward reference is safe.
  const focusBrowseSearch = async (query: string): Promise<void> => {
    await vscode.commands.executeCommand('grimoire.marketplace.focus');
    await sidebar.seedSearch(query);
    sidebar.focusSearch();
  };

  // Suspends file watchers around an extension-initiated mutation so the watcher
  // events its own writes fire don't pile redundant refreshes on top of the
  // action's completion refresh. `watchers` is declared below; this thunk only
  // reads it at call time, so the forward reference is safe.
  const suspendWhile = <T>(fn: () => Promise<T>): Promise<T> => watchers.suspendWhile(fn);

  const details = new DetailsManager(
    context.extensionUri,
    scopes,
    catalog,
    refreshAll,
    output,
    focusBrowseSearch,
    vscode.Uri.joinPath(context.globalStorageUri, 'details-cache').fsPath,
    suspendWhile,
  );

  // Background prefetch of top browse results into the details cache. onLogosLanded
  // reads the provider (declared below) at call time — forward-ref safe.
  const prefetcher = new Prefetcher({
    work: (repo) => details.prefetchInto(repo),
    isCached: (repo) => details.hasCached(repo),
    onLogosLanded: () => {
      void sidebar.repostLogos();
    },
    enabled: () => readConfig().prefetchDetails,
  });
  context.subscriptions.push(prefetcher);

  const delegate = {
    openDetails: (repo: string, mode: 'preview' | 'permanent') =>
      mode === 'preview' ? details.openPreview(repo) : details.open(repo),
    installGrim: offerInstallGrim,
    refreshAll,
    pin,
    suspendWhile,
    pickVersion: (repo: string) =>
      suspendWhile(() => pickVersion(repo, scopes, output, refreshAll)),
    cachedLogos: (repos: string[]) => details.cachedLogos(repos),
    prefetch: (repos: string[]) => void prefetcher.enqueue(repos),
  };

  const sidebar = new SidebarProvider(context.extensionUri, scopes, catalog, delegate, output);

  // Deep link: vscode://grimoire-rs.grimoire-vscode/open?repo=<repo> focuses Browse
  // with the artifact searched and opens its (permanent) details panel.
  const handleUri = async (uri: vscode.Uri): Promise<void> => {
    if (uri.path !== '/open') {
      return;
    }
    const repo = parseShareLink(uri.query);
    if (!repo || !isValidRepo(repo)) {
      return;
    }
    await focusBrowseSearch(artifactName(repo));
    details.open(repo);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('grimoire.marketplace', sidebar),
    vscode.window.registerWebviewPanelSerializer(DETAILS_VIEW_TYPE, details),
    vscode.window.registerUriHandler({ handleUri: (uri) => void handleUri(uri) }),
  );

  const watchers = new Watchers(() => {
    void refreshAll();
  });
  context.subscriptions.push(watchers);

  const rebuildWatchers = async (): Promise<void> => {
    const ctx = await scopes.run<ContextInfo>(contextArgs(), 'global');
    watchers.rebuild(ctx.ok ? ctx.value.grim_home : undefined);
  };
  void rebuildWatchers();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void rebuildWatchers();
      void refreshAll();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('grimoire')) {
        scopes.logExecutable(); // the executable setting may have just changed
        void rebuildWatchers();
        void refreshAll();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('grimoire.focusSearch', async () => {
      await vscode.commands.executeCommand('grimoire.marketplace.focus');
      sidebar.focusSearch();
    }),
    vscode.commands.registerCommand('grimoire.refresh', () => refreshAll()),
    vscode.commands.registerCommand('grimoire.updateAll', () =>
      suspendWhile(async () => {
        await runWithStatusProgress('Updating all artifacts', async () => {
          // Skip project unless it has a grimoire.toml — `grim update --project`
          // in an unconfigured workspace just errors.
          const failed = (scope: Scope, result: GrimResult<ActionReport>): void => {
            if (!result.ok) {
              const message =
                result.kind === 'not-found' ? 'grim executable not found' : result.message;
              output.appendLine(`error: grim update --${scope}: ${message}`);
              notifyError(`Grimoire: grim update (${scope}): ${message}`);
            }
          };
          if (await scopes.projectConfigured()) {
            failed('project', await scopes.run<ActionReport>(updateArgs(), 'project'));
          }
          failed('global', await scopes.run<ActionReport>(updateArgs(), 'global'));
        });
        await refreshAll();
      }),
    ),
    vscode.commands.registerCommand('grimoire.initProject', () =>
      suspendWhile(async () => {
        const result = await scopes.run<ActionReport>(initArgs(), 'project');
        if (!result.ok) {
          const message =
            result.kind === 'not-found' ? 'grim executable not found' : result.message;
          notifyError(`Grimoire: ${message}`);
        } else {
          void vscode.window.showInformationMessage('Created grimoire.toml');
        }
        await rebuildWatchers();
        await refreshAll();
      }),
    ),
    vscode.commands.registerCommand('grimoire.installGrim', () => runInstallGrim()),
    vscode.commands.registerCommand('grimoire.showOutput', () => output.show()),
    vscode.commands.registerCommand('grimoire.openDetails', (repo: unknown) => {
      if (typeof repo === 'string' && repo.length > 0) {
        details.open(repo);
      }
    }),
    vscode.commands.registerCommand('grimoire.reportBug', () =>
      vscode.env.openExternal(
        vscode.Uri.parse('https://github.com/grimoire-rs/grimoire/issues/new?template=bug_report.yml'),
      ),
    ),
    vscode.commands.registerCommand('grimoire.requestFeature', () =>
      vscode.env.openExternal(
        vscode.Uri.parse(
          'https://github.com/grimoire-rs/grimoire/issues/new?template=feature_request.yml',
        ),
      ),
    ),
  );

  return {
    refresh: refreshAll,
    scopes,
    providers: { sidebar, details },
    handleUri,
  };
}

export function deactivate(): void {
  // Disposables are handled via context.subscriptions.
}
