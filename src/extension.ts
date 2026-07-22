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
  type ItemsEnvelope,
  type Scope,
  type UpdateEntry,
} from './grim';
import {
  RELEASE_PAGE,
  SKIP_VERSION,
  UPDATE_GRIM,
  VIEW_RELEASE,
  fetchLatestVersion,
  installGrim,
  updateDecision,
} from './installer';
import { initNotify, notifyError, runWithStatusProgress } from './notify';
import { Prefetcher } from './prefetch';
import { ScopeService } from './scopes';
import { DetailsManager, DETAILS_VIEW_TYPE } from './views/details';
import { showGrimInfo } from './views/grimInfo';
import { pickVersion } from './views/pickVersion';
import { SettingsManager } from './views/settings';
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
    settings: SettingsManager;
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

  const refreshAll = async (options: { refresh?: boolean; check?: boolean } = {}): Promise<void> => {
    // sidebar.refresh posts its loading state BEFORE taking the snapshot (the
    // slow part), so the webview's refreshing-footer timer starts at t=0; the
    // details panels take their own snapshots inside buildVM regardless.
    // `settings` is declared below; this closure only reads it at call time
    // (async, post-activation), so the forward reference is safe.
    await Promise.all([
      sidebar.refresh(options),
      details.refreshOpenPanels(options),
      settings.refreshOpenPanel(),
    ]);
    // Self-heal the watchers. rebuildWatchers runs once at activation off a
    // single `grim context --global` probe with no retry; one transient
    // failure there leaves the global watchers unarmed for the whole session,
    // and every global-scope change made outside this extension then goes
    // unnoticed. The refresh above already snapshotted global scope, so the
    // grim home is in hand — re-arm from it rather than probing again.
    const grimHome = scopes.cachedSnapshot()?.global?.context.grim_home;
    if (grimHome !== undefined) {
      watchers.rebuild(grimHome);
    }
  };

  // Sidebar + details only, NOT settings — SettingsManager's own write/init
  // completion (writeInner/initProject in views/settings.ts) already reposts
  // its own panel explicitly once grim confirms. Feeding it the full
  // `refreshAll` above (which ALSO calls settings.refreshOpenPanel()) would
  // fetch `grim config list`/`registry list` and post 'state' TWICE per
  // write. Every other refreshAll trigger (install grim, workspace-folder or
  // configuration changes) is not itself a settings write, so those still go
  // through the full `refreshAll`, which does include settings.
  const refreshSidebarAndDetails = async (): Promise<void> => {
    await Promise.all([sidebar.refresh(), details.refreshOpenPanels()]);
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
        const message = result.kind === 'not-found' ? 'grim executable not found' : result.message;
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

  const settings = new SettingsManager(
    context.extensionUri,
    scopes,
    output,
    refreshSidebarAndDetails,
    offerInstallGrim,
    suspendWhile,
  );

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
    if (!ctx.ok) {
      // Silent until now, and the consequence is invisible: rebuild(undefined)
      // skips the whole global block, so the global grimoire.toml/lock and
      // state/global.json go unwatched for the rest of the session.
      const message = ctx.kind === 'not-found' ? 'grim executable not found' : ctx.message;
      output.appendLine(`watchers: global context probe failed (${message})`);
    }
    watchers.rebuild(ctx.ok ? ctx.value.grim_home : undefined);
  };
  void rebuildWatchers();

  // Daily grim update check. Best-effort background task: every failure is
  // log-only, never a toast. The extension only offers to overwrite a binary
  // it installed itself (globalStorage/bin); PATH/setting grims get notify-only.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const checkForUpdates = async (): Promise<void> => {
    try {
      if (!readConfig().checkForUpdates) {
        return;
      }
      // ponytail: read-then-write throttle on globalState — two windows
      // activating together can each prompt once; bounded, self-heals in a day.
      if (Date.now() - context.globalState.get<number>('updateCheck.lastCheck', 0) < DAY_MS) {
        return;
      }
      // Stamp before fetching so a flaky network can't hammer GitHub.
      await context.globalState.update('updateCheck.lastCheck', Date.now());
      // Once a day (same setting + throttle) also refresh the views with
      // network-verified `status --check` data, so update/deprecation badges are
      // honest rather than lock-state proxies. Fire-and-forget and decoupled
      // from the binary-version check below — a slow or failed status check
      // must not abort the grim-release prompt.
      void refreshAll({ check: true }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`update-badge check failed: ${message}`);
      });
      const latest = await fetchLatestVersion();
      if (!latest || latest === context.globalState.get<string>('updateCheck.skippedVersion')) {
        return;
      }
      const ctx = await scopes.run<ContextInfo>(contextArgs(), 'global');
      if (!ctx.ok) {
        return;
      }
      const prompt = updateDecision({
        latest,
        current: ctx.value.version,
        skipped: context.globalState.get<string>('updateCheck.skippedVersion'),
        // Read off the resolution itself (ScopeService.managedExecutable), never
        // re-derived here — the toast must not offer to overwrite a grim the
        // extension does not own.
        managed: scopes.managedExecutable(),
      });
      if (!prompt) {
        return;
      }
      const choice = await vscode.window.showInformationMessage(prompt.message, ...prompt.buttons);
      if (choice === UPDATE_GRIM) {
        await runInstallGrim();
      } else if (choice === VIEW_RELEASE) {
        void vscode.env.openExternal(vscode.Uri.parse(RELEASE_PAGE));
      } else if (choice === SKIP_VERSION) {
        await context.globalState.update('updateCheck.skippedVersion', latest);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`update check failed: ${message}`);
    }
  };
  void checkForUpdates();
  // Long-lived windows (WSL/remote stay open for days) re-check daily; the
  // globalState throttle makes repeat invocations idempotent.
  const updateTimer = setInterval(() => void checkForUpdates(), DAY_MS);
  context.subscriptions.push({ dispose: () => clearInterval(updateTimer) });

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
    // The explicit user refresh is the one path that busts grim's on-disk
    // catalog cache; watcher/config/post-action refreshes stay cheap.
    vscode.commands.registerCommand('grimoire.refresh', () => refreshAll({ refresh: true })),
    // Network-verified update/deprecation check (`grim status --check`), on
    // explicit request only — plain refreshes stay offline and cheap.
    vscode.commands.registerCommand('grimoire.checkArtifactUpdates', () =>
      refreshAll({ check: true }),
    ),
    vscode.commands.registerCommand('grimoire.updateAll', () =>
      suspendWhile(async () => {
        await runWithStatusProgress('Updating all artifacts', async () => {
          // Skip project unless it has a grimoire.toml — `grim update --project`
          // in an unconfigured workspace just errors.
          // Names dropped across BOTH scopes, split by why: reaped (unmodified
          // client output removed) vs. kept-modified (locally-edited output left
          // in place, needs `--force` to replace) — collected across the whole
          // command so one toast covers both scopes' runs.
          const reaped: string[] = [];
          const keptModified: string[] = [];
          const handle = (scope: Scope, result: GrimResult<ItemsEnvelope<UpdateEntry>>): void => {
            if (!result.ok) {
              const message =
                result.kind === 'not-found' ? 'grim executable not found' : result.message;
              output.appendLine(`error: grim update --${scope}: ${message}`);
              notifyError(`Grimoire: grim update (${scope}): ${message}`);
              return;
            }
            // Boundary guard: an envelope that parses ok but whose `items` is
            // missing or not an array must not poison the summary (same guard
            // as CatalogService.search).
            const items = Array.isArray(result.value.items) ? result.value.items : [];
            const counts: Record<UpdateEntry['action'], number> = {
              updated: 0,
              unchanged: 0,
              removed: 0,
              'kept-modified': 0,
            };
            for (const item of items) {
              counts[item.action]++;
              // `?? []` for the same reason the sibling arrays get it in
              // buildInstalled (webview/model.ts): nullable means null, and the
              // version floor is not an interlock — it only flags a too-old grim
              // in the snapshot, so `grim update` can still reach a binary that
              // predates these fields and an unguarded `.length` would throw.
              if ((item.reaped_clients ?? []).length > 0) {
                reaped.push(item.name);
              }
              if ((item.kept_modified_clients ?? []).length > 0) {
                keptModified.push(item.name);
              }
            }
            output.appendLine(
              `grim update (${scope}): ${counts.updated} updated, ${counts.unchanged} unchanged, ` +
                `${counts.removed} removed, ${counts['kept-modified']} kept-modified`,
            );
          };
          if (await scopes.projectConfigured()) {
            handle('project', await scopes.run<ItemsEnvelope<UpdateEntry>>(updateArgs(), 'project'));
          }
          handle('global', await scopes.run<ItemsEnvelope<UpdateEntry>>(updateArgs(), 'global'));
          // Reap only ever fires against an explicitly set `[options].clients`
          // (grim-side gate) — autodetect leaves both arrays empty on every
          // row, so this toast stays silent on the common path.
          if (reaped.length > 0 || keptModified.length > 0) {
            const parts: string[] = [];
            if (reaped.length > 0) {
              parts.push(`removed stale client output for ${reaped.join(', ')}`);
            }
            if (keptModified.length > 0) {
              parts.push(
                `kept locally-modified client output for ${keptModified.join(', ')} (rerun update --force to replace)`,
              );
            }
            void vscode.window.showInformationMessage(`Grimoire: update ${parts.join('; ')}.`);
          }
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
    vscode.commands.registerCommand('grimoire.openSettings', () => settings.open()),
    vscode.commands.registerCommand('grimoire.showOutput', () => output.show()),
    vscode.commands.registerCommand('grimoire.showGrimInfo', () => showGrimInfo(scopes)),
    vscode.commands.registerCommand('grimoire.openDetails', (repo: unknown) => {
      if (typeof repo === 'string' && repo.length > 0) {
        details.open(repo);
      }
    }),
    vscode.commands.registerCommand('grimoire.reportBug', () =>
      vscode.env.openExternal(
        vscode.Uri.parse(
          'https://github.com/grimoire-rs/grimoire/issues/new?template=bug_report.yml',
        ),
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
    providers: { sidebar, details, settings },
    handleUri,
  };
}

export function deactivate(): void {
  // Disposables are handled via context.subscriptions.
}
