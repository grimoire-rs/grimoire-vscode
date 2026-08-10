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
  REGISTRY_EDIT_GRIM_VERSION,
  RELEASE_PAGE,
  SKIP_VERSION,
  UPDATE_GRIM,
  VIEW_RELEASE,
  fetchLatestVersion,
  installGrim,
  supportsRegistryEditing,
  updateDecision,
} from './installer';
import { initNotify, notifyError, onBusyChange, runWithStatusProgress } from './notify';
import { Prefetcher } from './prefetch';
import { ScopeService, type CheckStore, type CheckedFields } from './scopes';
import { DetailsManager, DETAILS_VIEW_TYPE } from './views/details';
import { showGrimInfo } from './views/grimInfo';
import { pickVersion } from './views/pickVersion';
import { SettingsManager } from './views/settings';
import { SidebarProvider, scopeStatuses } from './views/sidebar';
import { UpdatesView } from './views/updatesView';
import { Watchers } from './watchers';
import {
  addRegistryPrompt,
  artifactName,
  firstUnknownScope,
  isValidRepo,
  parseAddRegistryLink,
  parseShareLink,
  refRepo,
  updateCount,
} from './webview/model';

export interface GrimoireApi {
  refresh(options?: RefreshOptions): Promise<void>;
  scopes: ScopeService;
  /** Test seams — not part of the public surface. */
  providers: {
    sidebar: SidebarProvider;
    details: DetailsManager;
    settings: SettingsManager;
    updates: UpdatesView;
  };
  /** Deep-link handler (test seam; fired for real via registerUriHandler). */
  handleUri(uri: vscode.Uri): Promise<void>;
  /** The refresh that opts into the daily `grim status --check` when it is
   *  enabled, due AND the workspace is trusted (test seam; fired for real via
   *  the config-change and trust-grant listeners and the daily timer). A seam
   *  because activation completes before any test body runs, so the trust gate
   *  is unreachable from the outside otherwise — and because trust is read on
   *  every call, not captured once at activation. */
  refreshWithDueCheck(): Promise<void>;
  /** Activation's badge-only round (test seam; fired for real once at
   *  activation). Exposed so a test can assert what it does and does not spawn:
   *  the count comes off the snapshot, never a catalog `grim search`. */
  publishUpdateCount(): Promise<void>;
  /** The extension's own globalState (test seam). The daily check's throttle
   *  stamp lives here and OUTLIVES the window, so it is the only lever a test
   *  has over whether the check is due: activation has already consumed the
   *  never-checked state (and stamped it) long before any test body runs. */
  globalState: vscode.Memento;
}

/** `refresh` busts grim's own catalog cache (`--refresh`); `check` opts into
 *  the network-verified `grim status --check`. Both are off by default. */
export interface RefreshOptions {
  refresh?: boolean;
  check?: boolean;
}

/** Union of two queued requests: a flag asked for by ANY coalesced caller must
 *  survive, or the explicit refresh a user clicked could be served by a cheap
 *  watcher-driven one that happened to be queued alongside it. */
function mergeRefreshOptions(a: RefreshOptions | undefined, b: RefreshOptions): RefreshOptions {
  return {
    refresh: a?.refresh === true || b.refresh === true,
    check: a?.check === true || b.check === true,
  };
}

/** Where each scope's remembered `--check` verdicts live. Project verdicts are
 *  about THIS workspace's grimoire.toml, so they belong in workspaceState:
 *  under one shared globalState record, two open workspaces pruned each other's
 *  project entries away (mergeCheckedFields self-prunes to the installed set)
 *  and the badge fell back to the lock proxy. Global verdicts are machine-wide,
 *  so they stay in globalState. The keys live here, not in ScopeService — see
 *  {@link CheckStore}. */
const CHECK_VERDICTS_KEY = 'artifactCheck.verdicts';

export function mementoCheckStore(
  workspaceState: vscode.Memento,
  globalState: vscode.Memento,
): CheckStore {
  const memento = (scope: Scope): vscode.Memento =>
    scope === 'project' ? workspaceState : globalState;
  return {
    read: (scope) => memento(scope).get<Record<string, CheckedFields>>(CHECK_VERDICTS_KEY, {}),
    write: async (scope, record) => {
      await memento(scope).update(CHECK_VERDICTS_KEY, record);
    },
  };
}

/** True when the daily `grim status --check` round is due. Pure so the three
 *  cases (off / within the day / past it) are testable without an activation.
 *  `lastCheck` is the stored epoch stamp; 0 (never checked) is always due. */
export function artifactCheckDue(
  enabled: boolean,
  lastCheck: number,
  now: number,
  dayMs: number,
): boolean {
  return enabled && now - lastCheck >= dayMs;
}

export function activate(context: vscode.ExtensionContext): GrimoireApi {
  const output = vscode.window.createOutputChannel('Grimoire', { log: true });
  context.subscriptions.push(output);
  initNotify(context);

  const scopes = new ScopeService(context.globalStorageUri, output);
  // Remember `grim status --check` verdicts across window reloads. The daily
  // throttle below is already persisted; without this the result it gates was
  // not, so a reloaded window fell back to the local lock proxy for up to a day
  // and the update count silently changed meaning.
  scopes.checkStore = mementoCheckStore(context.workspaceState, context.globalState);
  scopes.logExecutable();
  const catalog = new CatalogService(scopes);

  const runRefresh = async (options: RefreshOptions): Promise<void> => {
    // sidebar.refresh posts its loading state BEFORE taking the snapshot (the
    // slow part), so the webview's refreshing-footer timer starts at t=0; the
    // details panels take their own snapshots inside buildVM regardless.
    // `settings` is declared below; this closure only reads it at call time
    // (async, post-activation), so the forward reference is safe.
    // allSettled, not all: one participant throwing must neither abort the
    // others mid-round nor skip the self-heal below (an install's refresh that
    // arms the freshly-downloaded grim's watchers relies on it). Each rejection
    // is logged, never silently swallowed.
    const results = await Promise.allSettled([
      sidebar.refresh(options),
      details.refreshOpenPanels(options),
      settings.refreshOpenPanel(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        const reason: unknown = result.reason;
        const message = reason instanceof Error ? reason.message : String(reason);
        output.appendLine(`refresh participant failed: ${message}`);
      }
    }
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

  // Refreshes coalesce instead of piling up. A watcher event, a command, a
  // config change and an action's completion refresh can all land at once, and
  // each used to spawn its own full round of grim calls concurrently. Callers
  // queue their options (never downgraded — a `refresh: true` request stays
  // one) and await the drain, so an awaited refreshAll still means "state is
  // fresh" while only one round runs at a time.
  let draining: Promise<void> | undefined;
  let queued: RefreshOptions | undefined;

  const refreshAll = (options: RefreshOptions = {}): Promise<void> => {
    queued = mergeRefreshOptions(queued, options);
    // Yield one microtask before draining. An immediately-invoked async drain
    // runs its first iteration synchronously, emptying `queued` before
    // refreshAll even returns — so the second and third same-tick callers find
    // nothing queued and each pay for a full extra round of grim calls, the
    // exact cost this coalescer exists to remove.
    draining ??= Promise.resolve().then(async () => {
      try {
        while (queued !== undefined) {
          const next = queued;
          queued = undefined;
          // Per round, so one bad round is logged instead of aborting the
          // drain: a throw here used to discard the options queued behind it
          // and reject callers whose round never ran (grimoire.refresh hands
          // that promise to VS Code, which reports a command failure for a
          // refresh that did not happen).
          try {
            await runRefresh(next);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`refresh failed: ${message}`);
          }
        }
      } finally {
        draining = undefined;
      }
    });
    return draining;
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
      // No separate probe: the refresh takes a global snapshot and re-arms the
      // watchers from its grim home (see runRefresh).
      await refreshAll();
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
    // Every details cache write that carries a logo — prefetch OR a panel open —
    // pokes the (debounced) sidebar repost. `prefetcher` is declared below and
    // read at call time — forward-ref safe.
    () => prefetcher.notifyLogo(),
  );

  // Background prefetch of top browse results into the details cache. onLogosLanded
  // reads the provider (declared below) at call time — forward-ref safe.
  const prefetcher = new Prefetcher({
    work: (repo) => details.prefetchInto(repo),
    isFresh: (repo) => details.isFresh(repo),
    onLogosLanded: () => {
      void sidebar.repostLogos();
    },
    enabled: () => readConfig().prefetchDetails,
  });
  context.subscriptions.push(prefetcher);

  // Owns the activity-bar update count — see views/updatesView.ts for why the
  // sidebar webview cannot. Exists from activation, unlike the webview view.
  const updatesView = new UpdatesView();
  context.subscriptions.push(updatesView);

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
    setUpdateCount: (count: number) => updatesView.setCount(count),
  };

  const sidebar = new SidebarProvider(context.extensionUri, scopes, catalog, delegate, output);

  // One grim run at a time is all grim's lock allows, so while any mutating
  // action is in flight every view's action controls go inert — otherwise a
  // click during a slow install (a bundle) stalls behind it and reads as a dead
  // button. One signal, every surface: the sidebar cards and all open details
  // panels, whichever view started the run.
  context.subscriptions.push(
    onBusyChange((busy) => {
      sidebar.setBusy(busy);
      details.setBusy(busy);
    }),
  );

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
  // …/add-registry?index=<https url>&alias=<name> lets an index website offer a
  // one-click "add this index". That one writes, and the URI is attacker-supplied
  // (any page can navigate to it), so it is gated on a modal naming the exact URL
  // and alias — the link alone never authorizes a write.
  const handleUri = async (uri: vscode.Uri): Promise<void> => {
    if (uri.path === '/add-registry') {
      // A rejection is LOG-ONLY: a hostile page must learn nothing from the
      // response, but silence alone leaves a legitimate over-budget link
      // indistinguishable from a dead click.
      const link = parseAddRegistryLink(uri.query, (reason) =>
        output.appendLine(`add-registry link ignored: ${reason}`),
      );
      if (!link) {
        return;
      }
      // grim-polyfill<0.13.0: an older grim rejects --include/--exclude as
      // unknown arguments (exit 64), so a filtered link would confirm the write
      // in a modal and only then fail with raw clap stderr. Refuse first. An
      // unknown version does not refuse ("update grim" would be a guess), and a
      // pattern-free link is unaffected on any grim.
      const snapshot = scopes.cachedSnapshot();
      const version = snapshot?.global?.context.version ?? snapshot?.project?.context.version;
      const filtered = link.include.length > 0 || link.exclude.length > 0;
      if (filtered && version !== undefined && !supportsRegistryEditing(version)) {
        notifyError(
          `Grimoire: browse filters need grim ${REGISTRY_EDIT_GRIM_VERSION} or newer — ` +
            `update grim (${RELEASE_PAGE}).`,
        );
        return;
      }
      const { scope, detail } = addRegistryPrompt(link, scopes.projectFolder() !== undefined);
      const choice = await vscode.window.showWarningMessage(
        `Grimoire: add registry \`${link.alias}\`?`,
        { modal: true, detail },
        'Add Registry',
      );
      if (choice !== 'Add Registry') {
        return;
      }
      await settings.addRegistry(link.alias, { index: link.index }, scope, {
        include: link.include,
        exclude: link.exclude,
      });
      return;
    }
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
    // The home known BEFORE the probe is the ultimate fallback: a concurrent
    // refreshAll whose own probe failed can replace the cached snapshot with one
    // that carries no `global` at all mid-flight, and this pre-read survives that.
    const known = scopes.cachedSnapshot()?.global?.context.grim_home;
    const ctx = await scopes.run<ContextInfo>(contextArgs(), 'global');
    if (!ctx.ok) {
      // Silent until now, and the consequence is invisible: rebuild(undefined)
      // skips the whole global block, so the global grimoire.toml/lock and
      // state/global.json go unwatched for the rest of the session.
      const message = ctx.kind === 'not-found' ? 'grim executable not found' : ctx.message;
      output.appendLine(`watchers: global context probe failed (${message})`);
    }
    // A failed probe knows nothing NEW about the grim home, so it must not re-arm
    // with `undefined` — that disposes a global watcher set a refresh already
    // armed off its own snapshot, recreating the unarmed state this self-heal
    // exists to fix (including at activation, where `known` above was undefined
    // but a concurrent refresh has since armed a home). Read the cached snapshot
    // AFTER the await so that just-armed home is picked up rather than disposed;
    // fall back to the pre-probe `known`, and only `undefined` when there has
    // never been one (the folder watchers, whose key includes the workspace
    // folders, still rebuild).
    watchers.rebuild(
      ctx.ok ? ctx.value.grim_home : (scopes.cachedSnapshot()?.global?.context.grim_home ?? known),
    );
  };
  void rebuildWatchers();

  // Daily grim update check. Best-effort background task: every failure is
  // log-only, never a toast. The extension only offers to overwrite a binary
  // it installed itself (globalStorage/bin); PATH/setting grims get notify-only.
  //
  // The artifact check below is deliberately NOT the same task: one asks GitHub
  // about the grim CLI, the other asks the user's registries about installed
  // artifacts. They have their own setting and their own throttle key — a
  // private registry is not something to poll because someone left the GitHub
  // release check on, and the update count should not go dark because they
  // turned it off.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const ARTIFACT_CHECK_KEY = 'artifactCheck.lastCheck';

  /** Whether this round may run `grim status --check`, stamping the daily
   *  throttle when it may. Trust is read HERE, at call time, and gates THIS
   *  check — not the extension's network use in general: `--check` is the one
   *  call a restricted window makes with no user gesture behind it at all (it
   *  fires from activation and a timer), and it resolves every artifact against
   *  the registry set a WORKSPACE-controlled grimoire.toml names. A catalog
   *  `grim search` still runs untrusted through any refreshAll, and the manual
   *  **Check for Artifact Updates** command is deliberately ungated — invoking
   *  it IS the gesture. (`untrustedWorkspaces: "limited"` restricts two
   *  settings; it does not restrict any of this.) Reading trust once at
   *  activation would be both untestable and wrong: it can be granted
   *  mid-session, which is what onDidGrantWorkspaceTrust below re-runs this for.
   *  An untrusted window does not stamp, so the check is still due the moment
   *  trust arrives. */
  const artifactCheckIsDue = async (): Promise<boolean> => {
    if (!vscode.workspace.isTrusted) {
      return false;
    }
    const due = artifactCheckDue(
      readConfig().checkArtifactUpdates,
      context.globalState.get<number>(ARTIFACT_CHECK_KEY, 0),
      Date.now(),
      DAY_MS,
    );
    if (!due) {
      return false;
    }
    // Stamp before the call, like the GitHub check: a failing registry must not
    // make every refresh retry the network.
    await context.globalState.update(ARTIFACT_CHECK_KEY, Date.now());
    return true;
  };

  /** Refreshes every view, asking grim for network-verified update and
   *  deprecation data when the daily artifact check is due (see
   *  {@link artifactCheckIsDue}). A plain refresh otherwise — which still
   *  produces a correct update count, because the last check's verdicts are
   *  remembered (see ScopeService.checkStore) and no longer expire with the
   *  window. */
  const refreshWithDueCheck = async (): Promise<void> => {
    try {
      await refreshAll({ check: await artifactCheckIsDue() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`artifact update check failed: ${message}`);
    }
  };

  /** Activation's one round, and deliberately NOT `refreshWithDueCheck`. The
   *  count is the thing that must happen in every window — including one where
   *  Grimoire is never opened — and it needs the snapshot and nothing else
   *  (`updateCount` reads no field the catalog provides). The full refresh a
   *  plain activation used to run put a catalog search in front of the number,
   *  and then queued a details prefetch of up to 24 `grim describe` calls: that
   *  prefetch is enqueued AFTER the badge and is fire-and-forget, so it never
   *  delayed the number itself — it just kept the CLI busy behind it. And when
   *  the container WAS restored at startup, the round raced the webview's own
   *  `ready` refresh (which bypasses the refreshAll coalescer) with a duplicate.
   *  The daily check still runs here when due — and a round that actually
   *  checked ends in one full refresh, because by then the other views ARE
   *  looking at numbers this round has just superseded. */
  const publishUpdateCount = async (): Promise<void> => {
    try {
      const checked = await artifactCheckIsDue();
      const snap = await scopes.snapshot({ check: checked });
      // The watcher self-heal runRefresh ends in — activation no longer goes
      // through it. rebuildWatchers' own probe resolves BEFORE this snapshot, so
      // its cached-snapshot fallback is empty at activation and one transient
      // probe failure leaves the global watchers unarmed for the whole session.
      // This snapshot has the grim home in hand; rebuild() is idempotent.
      const grimHome = snap.global?.context.grim_home;
      if (grimHome !== undefined) {
        watchers.rebuild(grimHome);
      }
      const status = scopeStatuses(snap);
      // Same rule the sidebar applies (firstUnknownScope): never compute a count
      // off an unknown install state — one unreadable scope undercounts the other.
      if (firstUnknownScope(status) === undefined) {
        updatesView.setCount(updateCount(status));
      }
      // A checked round moved the verdicts every view renders, and nothing
      // orders this against the sidebar's own refresh — this round costs a
      // network `--check` against the sidebar's offline tens of milliseconds, so
      // without a repaint the icon carries post-check numbers while the Updates
      // pill keeps the pre-check ones until something unrelated refreshes. Only
      // after a check: a plain round tells the other views nothing new.
      if (checked) {
        void refreshAll();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`update count failed: ${message}`);
    }
  };
  void publishUpdateCount();
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
  // Long-lived windows (WSL/remote stay open for days) re-check daily; both
  // globalState throttles make repeat invocations idempotent.
  const updateTimer = setInterval(() => {
    void checkForUpdates();
    void refreshWithDueCheck();
  }, DAY_MS);
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
        // Due-check, not a plain refreshAll: turning grimoire.checkArtifactUpdates
        // ON is a user asking for the check, and a plain refresh would leave them
        // on the local lock proxy until the daily timer came round up to 24h later.
        void refreshWithDueCheck();
      }
    }),
    // Trust granted mid-session. The daily check is gated on it
    // (artifactCheckIsDue), so this is when a window that started restricted
    // gets the count it was not allowed to go and fetch.
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void refreshWithDueCheck();
    }),
  );

  context.subscriptions.push(
    // The activity-bar Updates row clicks through to the Updates tab. Not in
    // the command palette (package.json hides it) — it exists for that row.
    vscode.commands.registerCommand('grimoire.showUpdates', async () => {
      await vscode.commands.executeCommand('grimoire.marketplace.focus');
      sidebar.showTab('updates');
    }),
    vscode.commands.registerCommand('grimoire.focusSearch', async () => {
      await vscode.commands.executeCommand('grimoire.marketplace.focus');
      sidebar.focusSearch();
    }),
    // The explicit user refresh is the one path that busts grim's on-disk
    // catalog cache; watcher/config/post-action refreshes stay cheap.
    vscode.commands.registerCommand('grimoire.refresh', () => refreshAll({ refresh: true })),
    // Network-verified update/deprecation check (`grim status --check`), on
    // explicit request only — plain refreshes stay offline and cheap.
    vscode.commands.registerCommand('grimoire.checkArtifactUpdates', async () => {
      // Stamps the daily throttle: a check the user just ran by hand is still a
      // check, and the background one has nothing left to add today.
      await context.globalState.update(ARTIFACT_CHECK_KEY, Date.now());
      await refreshAll({ check: true });
    }),
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
            handle(
              'project',
              await scopes.run<ItemsEnvelope<UpdateEntry>>(updateArgs(), 'project'),
            );
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
        // `grim init` writes in the workspace folder; the folder watchers are
        // already armed for it and refreshAll re-arms the global set anyway.
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
    providers: { sidebar, details, settings, updates: updatesView },
    handleUri,
    refreshWithDueCheck,
    publishUpdateCount,
    globalState: context.globalState,
  };
}

export function deactivate(): void {
  // Disposables are handled via context.subscriptions.
}
