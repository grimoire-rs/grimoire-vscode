// The ONE WebviewViewProvider behind the single merged sidebar view. The old
// browse/updates/installed native views are internal tabs now (a single-view
// container merges the view header into the container header, so the title
// icons stay permanently visible and the view can't collapse): every refresh
// computes BOTH card sets — browse (catalog search) and installed (snapshot +
// catalog cache) — and posts them together; the webview slices per tab.
import * as vscode from 'vscode';
import {
  addArgs,
  initArgs,
  uninstallNotice,
  uninstallOrRemoveArgs,
  updateArgs,
  type ActionReport,
  type GrimResult,
  type Scope,
} from '../grim';
import type { CatalogService } from '../catalog';
import { projectSearchable, type ScopeService, type Snapshot } from '../scopes';
import {
  artifactName,
  authenticatedHosts,
  buildCards,
  buildInstalledCards,
  buildShareLink,
  registryUrlHost,
  type ScopeStatus,
} from '../webview/model';
import type { CardVM, HostToSidebar, SidebarState, SidebarToHost } from '../webview/protocol';
import { notifyError, reportGrimFailure, runWithStatusProgress } from '../notify';
import { webviewHtml } from './html';
import { offerForcedRetry } from './forceRetry';
import { offerFullUpdate } from './staleLock';
import { switchToReplacement } from './switchReplacement';

export interface SidebarDelegate {
  openDetails(repo: string, mode: 'preview' | 'permanent'): void;
  installGrim(): Promise<void>;
  refreshAll(): Promise<void>;
  pin(ref: string): Promise<void>;
  pickVersion(repo: string): Promise<void>;
  /** Suspends file watchers for the duration of a mutating action (its own
   *  writes' watcher events are redundant with the completion refresh). */
  suspendWhile<T>(fn: () => Promise<T>): Promise<T>;
  /** Cached logo data-URIs for the given repos (misses omitted). */
  cachedLogos(repos: string[]): Promise<Map<string, string>>;
  /** Background-prefetch the top of a fresh browse result list into the cache. */
  prefetch(repos: string[]): void;
}

export function scopeStatuses(snapshot: Snapshot): ScopeStatus[] {
  const scopes: ScopeStatus[] = [];
  if (snapshot.project) {
    scopes.push({
      scope: 'project',
      status: snapshot.project.status,
      declared: snapshot.project.declared,
    });
  }
  if (snapshot.global) {
    scopes.push({
      scope: 'global',
      status: snapshot.global.status,
      declared: snapshot.global.declared,
    });
  }
  return scopes;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private query = '';
  // Last-known default registry host, carried into the loading footer
  // ("Refreshing from <host>…") which is posted before the snapshot lands.
  private lastDefaultRegistry: string | undefined;
  // Last ready result, kept so a prefetch-driven logo repost can re-render without
  // the loading flash (and without a fresh grim round-trip).
  private lastReady:
    | { cards: CardVM[]; installed: CardVM[]; snap: Snapshot; syncedAt: number | null }
    | undefined;
  // In-flight refresh count; repostLogos stays quiet while > 0.
  private refreshing = 0;
  // Monotonic refresh generation. A refresh checks it after every await and
  // bails if a newer one has started, so a slow older refresh can never
  // overwrite a newer refresh's state (stale cards / badge / prefetch).
  private refreshGen = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly scopes: ScopeService,
    private readonly catalog: CatalogService,
    private readonly delegate: SidebarDelegate,
    private readonly output: vscode.OutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    view.webview.html = webviewHtml(view.webview, this.extensionUri, 'sidebar');
    view.webview.onDidReceiveMessage((message: SidebarToHost) => {
      void this.handleMessage(message);
    });
  }

  focusSearch(): void {
    this.post({ type: 'focusSearch' });
  }

  /** Seeds the search box (deep-link handler) so the query + results show. */
  async seedSearch(query: string): Promise<void> {
    this.query = query;
    await this.refresh();
  }

  private post(message: HostToSidebar): void {
    void this.view?.webview.postMessage(message);
  }

  /** Public for tests: the webview message entry point. */
  async handleMessage(message: SidebarToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.refresh();
        return;
      case 'search':
        this.query = message.query;
        await this.refresh();
        return;
      case 'refresh':
        await this.refresh({ refresh: true });
        return;
      case 'install': {
        // Installing into an unconfigured project needs grimoire.toml first:
        // `grim add` there errors (not-found, exit 79) before any network, so
        // run `grim init` then `grim add` as one step — mirrors the details
        // host (item 2). projectNeedsInit (not !projectConfigured): a FAILED
        // probe must not trigger init — see the method's doc.
        const needsInit =
          message.scope === 'project' && (await this.scopes.projectNeedsInit());
        const steps = needsInit
          ? [initArgs(), addArgs(message.ref)]
          : [addArgs(message.ref)];
        await this.runAction(steps, message.scope, `Installing ${message.ref}…`);
        return;
      }
      case 'uninstall':
        await this.runAction(
          [uninstallOrRemoveArgs(message.kind, message.name)],
          message.scope,
          message.kind === 'bundle'
            ? `Removing bundle ${message.name}…`
            : `Uninstalling ${message.name}…`,
        );
        return;
      case 'update':
        await this.runAction(
          [updateArgs([message.name])],
          message.scope,
          `Updating ${message.name}…`,
          message.name,
        );
        return;
      case 'switch':
        // Per-scope menu entry: the card supplied the install identity + the
        // grim-validated replacement ref (same trust as the install ref above).
        await switchToReplacement({
          scopes: this.scopes,
          targets: [{ scope: message.scope, kind: message.oldKind, name: message.oldName }],
          replacedBy: message.replacedBy,
          output: this.output,
          suspendWhile: (fn) => this.delegate.suspendWhile(fn),
          onDone: () => this.delegate.refreshAll(),
        });
        return;
      case 'pin':
        await this.delegate.pin(message.ref);
        return;
      case 'pickVersion':
        await this.delegate.pickVersion(message.repo);
        return;
      case 'openDetails':
        this.delegate.openDetails(message.repo, message.mode);
        return;
      case 'copyRepoPath':
        await vscode.env.clipboard.writeText(message.repo);
        void vscode.window.showInformationMessage(`Copied ${message.repo}`);
        return;
      case 'copyShareLink':
        await vscode.env.clipboard.writeText(buildShareLink(vscode.env.uriScheme, message.repo));
        void vscode.window.showInformationMessage(
          `Copied share link for ${artifactName(message.repo)}`,
        );
        return;
      case 'initProject':
        await this.runAction([initArgs()], 'project', 'Initializing grimoire.toml…');
        return;
      case 'installGrim':
        await this.delegate.installGrim();
        return;
    }
  }

  /** Runs one or more grim commands in sequence (e.g. init then add), stopping
   *  at the first failure; the failing/last step names the toast and drives
   *  the notice. */
  private async runAction(
    steps: string[][],
    scope: Scope,
    title: string,
    /** Artifact name for stale-lock recovery; set only by per-name update. */
    staleLockName?: string,
  ): Promise<void> {
    // Suspend watchers for the whole action: our own grim writes' events are
    // redundant with the delegate.refreshAll() this ends in.
    await this.delegate.suspendWhile(() => this.runActionInner(steps, scope, title, staleLockName));
  }

  private async runActionInner(
    steps: string[][],
    scope: Scope,
    title: string,
    staleLockName?: string,
  ): Promise<void> {
    const { args, result } = await runWithStatusProgress(title, async () => {
      let outcome!: { args: string[]; result: GrimResult<ActionReport> };
      for (const step of steps) {
        outcome = { args: step, result: await this.scopes.run<ActionReport>(step, scope) };
        if (!outcome.result.ok) {
          break;
        }
      }
      return outcome;
    });
    if (!result.ok) {
      // A stale-lock update offers a full re-resolve (which refreshes itself)
      // instead of the plain error toast.
      if (
        staleLockName !== undefined &&
        (await offerFullUpdate(result, staleLockName, scope, this.scopes, this.output, () =>
          this.delegate.refreshAll(),
        ))
      ) {
        return;
      }
      // A forceable drift refusal offers an Overwrite confirm; an anchor-escape
      // refusal gets a non-modal notice with no override — both handled instead
      // of the plain error toast below.
      if (
        await offerForcedRetry(result, args, scope, this.scopes, this.output, () =>
          this.delegate.refreshAll(),
        )
      ) {
        return;
      }
      // Name the failing step — an init→add sequence can fail halfway.
      reportGrimFailure(result, this.output, `grim ${args[0]}`);
    } else {
      const notice = uninstallNotice(result.value);
      if (notice) {
        void vscode.window.showInformationMessage(`Grimoire: ${notice}`);
      }
    }
    await this.delegate.refreshAll();
  }

  /** Recomputes state and posts it to the webview (state posts are no-ops
   *  until the view resolves; the ready message re-triggers a refresh). */
  async refresh(options: { refresh?: boolean; check?: boolean } = {}): Promise<void> {
    this.postState({ phase: 'loading', items: [], installed: [] });
    // Suppress prefetch-driven logo reposts while a refresh is in flight — a
    // stale ready post would cancel the webview's pending refreshing-footer
    // swap. Counter, not boolean: watcher and manual refreshes overlap.
    const gen = ++this.refreshGen;
    this.refreshing++;
    try {
      await this.doRefresh(options, gen);
    } finally {
      this.refreshing--;
    }
  }

  private async doRefresh(
    options: { refresh?: boolean; check?: boolean },
    gen: number,
  ): Promise<void> {
    // `check` (network-verified update/deprecation data) threads to
    // `grim status --check`; the search options below stay as-is.
    const snap = await this.scopes.snapshot(options);
    if (gen !== this.refreshGen) {
      return; // a newer refresh started while snapshotting — it owns the state
    }
    if (snap.grimMissing) {
      this.postState({ phase: 'no-grim', items: [], installed: [] });
      return;
    }
    // One catalog search feeds both card sets: browse cards straight from the
    // results, installed cards from the snapshot enriched by the same items.
    const catalogState = await this.catalog.search(this.query, {
      ...options,
      projectConfigured: projectSearchable(snap),
    });
    if (gen !== this.refreshGen) {
      return; // superseded during the search
    }
    if (catalogState.grimMissing) {
      this.postState({ phase: 'no-grim', items: [], installed: [] });
      return;
    }
    const defaultRegistry = snap.global?.context.default_registry;
    this.lastDefaultRegistry = defaultRegistry ? registryUrlHost(defaultRegistry) : undefined;
    const scopeStatus = scopeStatuses(snap);
    const authed = authenticatedHosts(snap.global?.context.registries ?? []);
    // Default registry host, so a stored credential for it (many users are
    // docker-logged-in to ghcr.io, the default) doesn't lock-mark every card.
    const defaultRegistryHost = this.lastDefaultRegistry ?? null;
    const cards = buildCards(catalogState.items, scopeStatus, authed, defaultRegistryHost);
    // Both scopes' installs; the webview slices Updates (outdated) and the
    // Installed tab's SCOPE toggle client-side.
    const installed = buildInstalledCards(
      catalogState.items,
      scopeStatus,
      authed,
      defaultRegistryHost,
    );
    await this.enrichLogos(cards);
    await this.enrichLogos(installed);
    if (gen !== this.refreshGen) {
      return; // superseded during logo enrichment — don't clobber newer state
    }
    // A failed status call (snap.error) means install state is unknown — the
    // cards were built from an EMPTY status list and would lie "Install" on
    // installed artifacts, so it surfaces as the same error phase a catalog
    // failure does. Those lying cards also must not become lastReady (a late
    // logo repost would repaint them as 'ready' over the error state); the
    // badge stays untouched too — clearing it off empty data is the same lie
    // in miniature. Catalog errors keep updating lastReady as before: their
    // cards are built from a GOOD status plus the cached catalog.
    if (snap.error === undefined) {
      this.lastReady = { cards, installed, snap, syncedAt: catalogState.syncedAt };
    }
    const error = catalogState.error ?? snap.error;
    if (snap.error === undefined) {
      this.setBadge(installed.filter((c) => c.state === 'outdated').length);
    }
    // The badge freezes on a failed status (above), so the cards must freeze
    // with it: posting the empty-status set while the badge keeps its old count
    // makes the Updates tab's pill (same formula, same field — render.ts) and
    // the activity-bar badge state different numbers at the same time. That
    // disagreement IS the "badge won't clear after an update" report: the update
    // succeeded, the tab emptied, the frozen badge stayed. Last known-good for
    // both, or nothing at all when there is no known-good yet.
    const shown = snap.error !== undefined ? this.lastReady : undefined;
    if (error !== undefined) {
      // Other refresh triggers can race a watcher-driven one and carry the same
      // error; notifyError's dedupe collapses them to one popup.
      notifyError(`Grimoire: ${error}`, { dedupe: true });
    }
    this.postState({
      phase: error !== undefined ? 'error' : 'ready',
      items: shown?.cards ?? cards,
      installed: shown?.installed ?? installed,
      ...(error !== undefined ? { error } : {}),
      syncedAt: catalogState.syncedAt,
      snapshot: snap,
    });
    // Browse results drive the prefetch (top-K handled by the prefetcher).
    // Skip on error results.
    if (error === undefined) {
      this.delegate.prefetch(cards.map((c) => c.repo));
    }
  }

  /** Native view badge (outdated count): it rolls up into the activity-bar
   *  icon's number, which must mean "updates available", not "artifacts
   *  installed". Cleared at zero. Also drives the `grimoire.updatesAvailable`
   *  context key that shows/hides the conditional Update All toolbar icon —
   *  kept in this single choke point so badge and icon can never disagree. */
  private setBadge(count: number): void {
    void vscode.commands.executeCommand('setContext', 'grimoire.updatesAvailable', count > 0);
    if (!this.view) {
      return;
    }
    this.view.badge = count > 0 ? { value: count, tooltip: `${count} available` } : undefined;
  }

  /** Sets card.logoUri from the details cache (misses stay codicon tiles). */
  private async enrichLogos(cards: CardVM[]): Promise<void> {
    if (cards.length === 0) {
      return;
    }
    const logos = await this.delegate.cachedLogos(cards.map((c) => c.repo));
    for (const card of cards) {
      const logo = logos.get(card.repo);
      if (logo) {
        card.logoUri = logo;
      }
    }
  }

  /** Re-enriches the last ready result's logos and reposts WITHOUT the loading
   *  flash — pops in logos as prefetches land (debounced by the prefetcher). */
  async repostLogos(): Promise<void> {
    const ready = this.lastReady;
    if (!ready || this.refreshing > 0) {
      return;
    }
    await this.enrichLogos(ready.cards);
    await this.enrichLogos(ready.installed);
    // Re-check after the await gap: a refresh may have started (or replaced
    // lastReady) while the logo reads were in flight — posting now would emit
    // a stale ready state that cancels the webview's refreshing footer.
    if (this.refreshing > 0 || this.lastReady !== ready) {
      return;
    }
    this.postState({
      phase: 'ready',
      items: ready.cards,
      installed: ready.installed,
      syncedAt: ready.syncedAt,
      snapshot: ready.snap,
    });
  }

  private postState(partial: {
    phase: SidebarState['phase'];
    items: SidebarState['items'];
    installed: SidebarState['installedItems'];
    error?: string;
    syncedAt?: number | null;
    snapshot?: Snapshot;
  }): void {
    const snap = partial.snapshot;
    const projectName = snap?.projectFolder
      ? (snap.projectFolder.split(/[\\/]/).pop() ?? null)
      : null;
    const state: SidebarState = {
      phase: partial.phase,
      // The wire mode is always 'browse' (`items` are the browse cards); the
      // webview re-stamps the active tab before rendering (model.ts viewForTab).
      mode: 'browse',
      query: this.query,
      items: partial.items,
      installedItems: partial.installed,
      scopes: {
        projectOpen: snap?.projectFolder !== undefined,
        // snap can be undefined here (posted before a snapshot exists, e.g. the
        // 'loading' phase); keep the pre-existing false default in that case.
        projectConfigured: snap ? projectSearchable(snap) : false,
        projectName,
      },
      registries: snap?.global?.context.registries.map((r) => r.url) ?? [],
      defaultRegistry: this.lastDefaultRegistry ?? null,
      syncedAt: partial.syncedAt ?? null,
      now: Date.now(),
      ...(partial.error !== undefined ? { error: partial.error } : {}),
    };
    this.post({ type: 'state', state });
  }
}
