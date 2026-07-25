// The ONE WebviewViewProvider behind the sidebar's marketplace view. The old
// browse/updates/installed native views are internal tabs of it now: every
// refresh computes BOTH card sets — browse (catalog search) and installed
// (snapshot + catalog cache) — and posts them together; the webview slices per
// tab.
//
// Merging them into one view was originally also what kept the container a
// SINGLE-view container, where VS Code folds the view header into the container
// header — title icons permanently visible, nothing to collapse. That no longer
// holds unconditionally: `grimoire.updates` (views/updatesView.ts) is a second
// native view in the same container, because only a TreeView can carry the
// activity-bar count in a window where this webview is never resolved. Its
// `when` clause keeps it out of the container until updates are actually
// pending, so the folded single-view header is still the normal state; the price
// is that while a count is up the container shows two rows and this view's
// header separates back out. `visibility: collapsed` on the other one only sets
// its INITIAL state — VS Code persists a user's expand, so it is a default, not
// a guarantee of one header row. A count in every window is worth that.
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
  firstUnknownScope,
  registryUrlHost,
  updateCount,
  type ScopeStatus,
} from '../webview/model';
import type {
  CardVM,
  GrimOrigin,
  HostToSidebar,
  SidebarState,
  SidebarToHost,
} from '../webview/protocol';
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
  /** Publishes the outdated count to whatever owns the activity-bar badge (see
   *  views/updatesView.ts for why that is not this webview). */
  setUpdateCount(count: number): void;
}

/** The SINGLE producer of render-facing scope status — every "install state
 *  unknown" decision (cards, details rows, the sidebar banner) funnels through
 *  a `status: null` here. Per scope: a real ScopeSnapshot emits its status +
 *  reason; a scope that is ABSENT but whose `grim context` probe failed
 *  (project/globalProbeFailed) is synthesized as a `status: null` /
 *  `'probe-failed'` row so a genuinely unreadable scope suppresses rather than
 *  reads as empty. The ordinary "no grimoire.toml" project (no probe flag) stays
 *  omitted, so an unconfigured project still emits no row. */
export function scopeStatuses(snapshot: Snapshot): ScopeStatus[] {
  const scopes: ScopeStatus[] = [];
  for (const scope of ['project', 'global'] as const) {
    const snap = snapshot[scope];
    if (snap) {
      scopes.push({
        scope,
        status: snap.status,
        ...(snap.statusUnknownReason !== undefined
          ? { unknownReason: snap.statusUnknownReason }
          : {}),
        declared: snap.declared,
      });
    } else if (scope === 'project' ? snapshot.projectProbeFailed : snapshot.globalProbeFailed) {
      scopes.push({ scope, status: null, unknownReason: 'probe-failed', declared: {} });
    }
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
    { cards: CardVM[]; installed: CardVM[]; snap: Snapshot; syncedAt: number | null } | undefined;
  // Last-known install-state trust, updated the moment a snapshot lands and
  // stamped onto EVERY post by postState. Kept on the provider rather than
  // passed per post because the two posts that most need it don't have a
  // snapshot to read: the `phase:'loading'` post that opens the next refresh
  // (otherwise the banner blinks out and back every watcher round) and a
  // repostLogos, whose lastReady predates the failure by construction — it is
  // only ever assigned on a round where status worked.
  private lastUnknown:
    | {
        message: string;
        reason?: 'too-old' | 'status-failed' | 'probe-failed';
        origin?: GrimOrigin;
      }
    | undefined;
  // In-flight refresh count; repostLogos stays quiet while > 0.
  private refreshing = 0;
  // A logo repost that arrived mid-refresh, replayed once the refresh drains.
  // Without it the signal is LOST: the debounce upstream has already fired, and
  // the refresh's own enrichLogos may have run before the logo was cached — so
  // the card keeps its codicon tile until some unrelated later refresh.
  private logoRepostPending = false;
  // Monotonic refresh generation. A refresh checks it after every await and
  // bails if a newer one has started, so a slow older refresh can never
  // overwrite a newer refresh's state (stale cards / badge / prefetch).
  private refreshGen = 0;
  // The webview's boot handshake. A resolved postMessage does NOT mean
  // delivered (@types/vscode: "the message can only be delivered if the webview
  // is live"), so a setTab or focusSearch issued while the view was still
  // booting was dropped silently — the Updates row's click-through lost exactly
  // when the click is what opened the container. The `ready` message is the
  // only signal that a post can land; `this.view` is NOT (resolveWebviewView
  // assigns it long before the webview process boots, so guarding on it drops
  // the same messages).
  private ready = false;
  // Posts held until then, ONE PER MESSAGE TYPE — last wins. showTab('installed')
  // then showTab('updates') delivers `updates`: the user's latest intent is the
  // right one, and a queue of N identical setTabs against a webview that may
  // never resolve is not. A `state` post is deliberately NOT held — it keeps
  // going out best-effort exactly as before: the ready handler runs a full
  // refresh of its own, so a held one would only repaint cards that are stale by
  // the time they land.
  private readonly pendingPosts = new Map<HostToSidebar['type'], HostToSidebar>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly scopes: ScopeService,
    private readonly catalog: CatalogService,
    private readonly delegate: SidebarDelegate,
    private readonly output: vscode.OutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // A fresh webview process, which has not said `ready` yet. Re-resolution is
    // routine, not a one-off: without retainContextWhenHidden VS Code disposes a
    // hidden view and resolves a new one when it comes back, so leaving the flag
    // set would fire the next boot's posts into a webview that is not listening.
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    view.webview.html = webviewHtml(view.webview, this.extensionUri, 'sidebar');
    // Down again the moment the view is disposed, not only on the next resolve:
    // between the two, `post` would hand messages to a dead webview instead of
    // holding them for the boot that follows.
    view.onDidDispose(() => {
      this.ready = false;
    });
    view.webview.onDidReceiveMessage((message: SidebarToHost) => {
      void this.handleMessage(message);
    });
  }

  focusSearch(): void {
    this.post({ type: 'focusSearch' });
  }

  /** Switches the webview's internal tab bar (the activity-bar Updates row). */
  showTab(tab: SidebarState['mode']): void {
    this.post({ type: 'setTab', tab });
  }

  /** Seeds the search box (deep-link handler) so the query + results show. */
  async seedSearch(query: string): Promise<void> {
    this.query = query;
    await this.refresh();
  }

  private post(message: HostToSidebar): void {
    if (!this.ready && message.type !== 'state') {
      this.pendingPosts.set(message.type, message);
      return;
    }
    void this.view?.webview.postMessage(message);
  }

  /** Public for tests: the webview message entry point. */
  async handleMessage(message: SidebarToHost): Promise<void> {
    switch (message.type) {
      case 'ready': {
        // The webview is live from here. The flag goes up FIRST: the drain
        // below posts through post(), which would otherwise put every message
        // straight back in the map and deliver nothing at all.
        this.ready = true;
        // Drain before the refresh — these are the posts that raced the boot.
        const pending = [...this.pendingPosts.values()];
        this.pendingPosts.clear();
        for (const message of pending) {
          this.post(message);
        }
        await this.refresh();
        return;
      }
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
        const needsInit = message.scope === 'project' && (await this.scopes.projectNeedsInit());
        const steps = needsInit ? [initArgs(), addArgs(message.ref)] : [addArgs(message.ref)];
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
      case 'showGrimInfo':
        // Opens the grim-info modal (registered in extension.ts). Executed as a
        // command rather than routed through the delegate — it is pure
        // diagnostics with no state to plumb back.
        await vscode.commands.executeCommand('grimoire.showGrimInfo');
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
      if (this.refreshing === 0 && this.logoRepostPending) {
        this.logoRepostPending = false;
        void this.repostLogos(); // replay the signal this refresh swallowed
      }
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
      this.lastUnknown = undefined; // no grim at all is its own state, not a degraded one
      // Cleared, not frozen: unlike an unknown install state, "there is no grim"
      // is a definite answer, and a leftover count would keep pointing at an
      // Updates tab that now renders the no-grim state.
      this.setBadge(0);
      this.postState({ phase: 'no-grim', items: [], installed: [] });
      return;
    }
    // Trust verdict for this round, recorded before the catalog search so every
    // post below carries it — and so a round whose status worked CLEARS it (the
    // banner is last-known, not sticky). ONE source: the render funnel's first
    // `status: null` scope, NOT snap.error — so a probe-failed scope (no error
    // string) still trips the banner, and reason + message can never disagree
    // (both come off the same scope). resolvedExecutable's origin gates which
    // remedy the banner may offer; computed only when there IS an unknown, so a
    // healthy refresh pays no PATH scan.
    const scopeStatus = scopeStatuses(snap);
    const firstUnknown = firstUnknownScope(scopeStatus);
    this.lastUnknown = firstUnknown
      ? {
          message: snap.error ?? `Could not determine the ${firstUnknown.scope} install state.`,
          ...(firstUnknown.unknownReason !== undefined
            ? { reason: firstUnknown.unknownReason }
            : {}),
          origin: this.scopes.resolvedExecutable().origin,
        }
      : undefined;
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
      this.lastUnknown = undefined;
      this.setBadge(0); // same definite answer as the snapshot's own no-grim above
      this.postState({ phase: 'no-grim', items: [], installed: [] });
      return;
    }
    const defaultRegistry = snap.global?.context.default_registry;
    this.lastDefaultRegistry = defaultRegistry ? registryUrlHost(defaultRegistry) : undefined;
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
    // cards were built from an UNKNOWN status list and would lie "Install" on
    // installed artifacts. The catalog itself is fine, though, so browsing
    // stays available: the state posts `installStateUnknown` and the webview
    // renders a persistent banner, drops every install/update affordance, and
    // says so on the Updates/Installed tabs instead of reading as empty.
    // Blanking the whole view (the old behavior) made one stale binary look
    // like a broken extension.
    //
    // Those cards still must not become lastReady, and the badge stays
    // untouched — clearing it off unknown data is the same lie in miniature.
    // (lastReady may then be an OLDER, healthy round; a later logo repost of it
    // still carries this.lastUnknown, so it repaints with the banner up and the
    // affordances suppressed rather than as a clean, fully-trusted 'ready'.)
    // Gate on the render funnel, not snap.error: a project-probe failure
    // synthesizes a status:null scope WITHOUT setting snap.error, and its cards
    // are just as untrusted — storing them as lastReady or recomputing the badge
    // from a single known scope would undercount updates the banner says are
    // unavailable.
    if (firstUnknown === undefined) {
      this.lastReady = { cards, installed, snap, syncedAt: catalogState.syncedAt };
      // Off the scopes, not off `installed` — the same one derivation activation
      // publishes from (see webview/model.ts updateCount). The two used to be
      // separate expressions that agreed only because catalog items happen not
      // to touch any field hasUpdate reads.
      this.setBadge(updateCount(scopeStatus));
    }
    // A catalog failure is the one that still has nothing to show: its cards
    // come from a possibly-empty result set, so it keeps the error phase.
    const catalogError = catalogState.error;
    if (catalogError !== undefined) {
      // Other refresh triggers can race a watcher-driven one and carry the same
      // error; notifyError's dedupe collapses them to one popup.
      notifyError(`Grimoire: ${catalogError}`, { dedupe: true });
    }
    this.postState({
      phase: catalogError !== undefined ? 'error' : 'ready',
      items: cards,
      installed,
      ...(catalogError !== undefined ? { error: catalogError } : {}),
      // The status failure itself rides this.lastUnknown (stamped by postState).
      // The banner is persistent, so it needs no toast of its own — that would
      // re-fire on every refresh for as long as the failure persists.
      syncedAt: catalogState.syncedAt,
      snapshot: snap,
    });
    // Browse results drive the prefetch (top-K handled by the prefetcher).
    // Skip on error results.
    if (catalogError === undefined) {
      this.delegate.prefetch(cards.map((c) => c.repo));
    }
  }

  /** The outdated count that rolls up into the activity-bar icon's number,
   *  which must mean "updates available", not "artifacts installed". Cleared at
   *  zero.
   *
   *  Handed to the delegate rather than set on `this.view`: a WebviewView's
   *  badge only exists once VS Code resolves the view, which it defers until
   *  the view first becomes visible, so this count was invisible in any window
   *  where Grimoire was never opened. UpdatesView owns it now (and the
   *  `grimoire.updatesAvailable` context key with it). Still the single choke
   *  point on this side — every count the sidebar computes goes through here. */
  private setBadge(count: number): void {
    this.delegate.setUpdateCount(count);
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
    if (this.refreshing > 0) {
      this.logoRepostPending = true; // replayed when the refresh drains
      return;
    }
    const ready = this.lastReady;
    if (!ready) {
      return; // nothing painted yet — the first ready post enriches from cache
    }
    await this.enrichLogos(ready.cards);
    await this.enrichLogos(ready.installed);
    // Re-check after the await gap: a refresh may have started (or replaced
    // lastReady) while the logo reads were in flight — posting now would emit
    // a stale ready state that cancels the webview's refreshing footer.
    if (this.refreshing > 0) {
      this.logoRepostPending = true;
      return;
    }
    if (this.lastReady !== ready) {
      return; // a newer ready post already enriched from the same cache
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
      // Every post carries the current trust verdict — loading, ready and logo
      // repost alike. One source, so no post can silently drop it.
      ...(this.lastUnknown !== undefined
        ? {
            installStateUnknown: this.lastUnknown.message,
            ...(this.lastUnknown.reason !== undefined
              ? { installStateUnknownReason: this.lastUnknown.reason }
              : {}),
            ...(this.lastUnknown.origin !== undefined
              ? { installStateUnknownOrigin: this.lastUnknown.origin }
              : {}),
          }
        : {}),
    };
    this.post({ type: 'state', state });
  }
}
