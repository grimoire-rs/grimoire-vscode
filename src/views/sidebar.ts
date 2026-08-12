// The ONE WebviewViewProvider behind the sidebar's marketplace view. The old
// browse/updates/installed native views are internal tabs of it now: every
// refresh computes BOTH card sets — browse (catalog search) and installed
// (snapshot + catalog cache) — and posts them together; the webview slices per
// tab.
//
// Merging them into one view is also what keeps the container a SINGLE-view
// container, where VS Code folds the view header into the container header —
// title icons permanently visible, nothing to collapse. A second native view in
// the container (there used to be one, carrying the update badge) splits that
// header back out, so the badge lives on this view instead: it costs a count
// that only appears once the view has been resolved, and buys one header row.
import * as vscode from 'vscode';
import {
  addArgs,
  initArgs,
  installArgs,
  uninstallNotice,
  uninstallOrRemoveArgs,
  updateArgs,
  type ActionReport,
  type GrimResult,
  type Scope,
} from '../grim';
import type { CatalogService } from '../catalog';
import type { CachedCardMeta } from '../detailsCache';
import {
  projectSearchable,
  searchScopeFor,
  type ScopeService,
  type Snapshot,
} from '../scopes';
import {
  applyCardMeta,
  artifactName,
  authenticatedHosts,
  buildCards,
  buildInstalledCards,
  buildShareLink,
  firstUnknownScope,
  isValidRepo,
  refRepo,
  registryUrlHost,
  repoForInstall,
  updateCount,
  type ScopeStatus,
} from '../webview/model';
import type {
  CardVM,
  GrimOrigin,
  HostToSidebar,
  RegistryVM,
  SidebarState,
  SidebarToHost,
  ViewAction,
  ViewOptions,
} from '../webview/protocol';
import { notifyError, reportGrimFailure, runWithStatusProgress } from '../notify';
import { webviewHtml } from './html';
import { offerForcedRetry } from './forceRetry';
import { offerFullUpdate } from './staleLock';
import { switchToReplacement } from './switchReplacement';
import { offerInstallRefusal } from './updateRefusal';

/** globalState key for the view preference (density / list-vs-tree / grouping). */
const VIEW_PREFS_KEY = 'grimoire.sidebar.view';

/** Rows seeded into the prefetch the moment results land, before the webview
 *  reports its viewport. Roughly a tall window of compact rows — the real work
 *  list is the `visible` report, which supersedes this within a frame or two. */
const SEED_SWEEP = 24;

/** Sanity ceiling on the webview's viewport report. A tall sidebar of compact
 *  rows plus the observer's 400px margin reports on the order of 100 repos, so
 *  this is far above any real viewport — it exists so a webview that ever posted
 *  a pathological list could not turn it into that many grim spawns, not to
 *  reinstate the fixed top-K the viewport sweep replaced. */
const MAX_VISIBLE_REPOS = 500;

export interface SidebarDelegate {
  openDetails(repo: string, mode: 'preview' | 'permanent'): void;
  installGrim(): Promise<void>;
  refreshAll(): Promise<void>;
  pin(ref: string): Promise<void>;
  pickVersion(repo: string): Promise<void>;
  /** Suspends file watchers for the duration of a mutating action (its own
   *  writes' watcher events are redundant with the completion refresh). */
  suspendWhile<T>(fn: () => Promise<T>): Promise<T>;
  /** Cached logo + latest-version card decorations for the given repos (misses
   *  omitted). */
  cachedCardMeta(repos: string[]): Promise<Map<string, CachedCardMeta>>;
  /** Ages a repo's cached registry snapshot out after an action changed that
   *  artifact, so the refresh that follows re-resolves its version. Expires
   *  rather than deletes — the content stays as the merge base a partly-failed
   *  re-probe folds into, which is the whole point (DetailsManager.expire). */
  expireCached(repo: string): void;
  /** Background-prefetch the top of a fresh browse result list into the cache.
   *  `force` bypasses the cache TTL — an explicit refresh re-resolves versions
   *  rather than repainting yesterday's answer. */
  prefetch(repos: string[], options?: { force?: boolean }): void;
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
  /** Last published update count — see setUpdateCount. */
  private badgeCount = 0;
  private query = '';
  // Last-known default registry host, carried into the loading footer
  // ("Refreshing from <host>…") which is posted before the snapshot lands.
  private lastDefaultRegistry: string | undefined;
  /** Registries of the scope the last search used — see the searchContext
   *  derivation in doRefresh. Rides every post so the webview's grouping and
   *  tree can name them by their configured alias. */
  private lastRegistries: RegistryVM[] = [];
  // Last ready result, kept so a prefetch-driven logo repost can re-render without
  // the loading flash (and without a fresh grim round-trip).
  private lastReady:
    { cards: CardVM[]; installed: CardVM[]; snap: Snapshot; syncedAt: number | null } | undefined;
  // Last-known install-state trust, updated the moment a snapshot lands and
  // stamped onto EVERY post by postState. Kept on the provider rather than
  // passed per post because the two posts that most need it don't have a
  // snapshot to read: the `phase:'loading'` post that opens the next refresh
  // (otherwise the banner blinks out and back every watcher round) and a
  // repostCardMeta, whose lastReady predates the failure by construction — it is
  // only ever assigned on a round where status worked.
  private lastUnknown:
    | {
        message: string;
        reason?: 'too-old' | 'status-failed' | 'probe-failed';
        origin?: GrimOrigin;
      }
    | undefined;
  // In-flight refresh count; repostCardMeta stays quiet while > 0.
  private refreshing = 0;
  /** Set when the results just posted came from an explicit refresh/check, so
   *  the viewport report that follows re-resolves instead of trusting the cache.
   *  One-shot: scrolling afterwards is not a refresh. */
  private forcePrefetch = false;
  // A logo repost that arrived mid-refresh, replayed once the refresh drains.
  // Without it the signal is LOST: the debounce upstream has already fired, and
  // the refresh's own enrichCards may have run before the logo was cached — so
  // the card keeps its codicon tile until some unrelated later refresh.
  private metaRepostPending = false;
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
    /** Where the view preference lives. globalState, not workspaceState: how a
     *  list is drawn is a habit, not a property of one project. */
    private readonly memento: vscode.Memento,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // Whatever count is already known: this may be the first resolve in the
    // window, and the badge object did not exist when it was published.
    this.applyBadge();
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

  /** Locks (title) or unlocks (null) every action control in the view while a
   *  grim run is in flight anywhere — see notify.ts's onBusyChange. */
  setBusy(busy: string | null): void {
    this.post({ type: 'busy', busy });
  }

  /** Switches the webview's internal tab bar (the activity-bar Updates row). */
  showTab(tab: SidebarState['mode']): void {
    this.post({ type: 'setTab', tab });
  }

  /** A view control fired from the title bar (or the command palette). The
   *  webview owns the state — see the `viewAction` message. */
  viewAction(action: ViewAction): void {
    this.post({ type: 'viewAction', action });
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
        // The stored preference first, before any results land: the webview's
        // own setState is workspace-scoped and dies with the view, so this is
        // what carries density/tree/grouping across a restart. Nothing stored
        // (first ever run) leaves the webview on its own defaults.
        const storedView = this.memento.get<ViewOptions>(VIEW_PREFS_KEY);
        if (storedView) {
          this.post({ type: 'viewPrefs', view: storedView });
        }
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
        this.delegate.expireCached(refRepo(message.ref));
        await this.runAction(steps, message.scope, `Installing ${message.ref}…`);
        return;
      }
      case 'uninstall':
        this.forgetInstalled(message.kind, message.name, message.scope);
        await this.runAction(
          [uninstallOrRemoveArgs(message.kind, message.name)],
          message.scope,
          message.kind === 'bundle'
            ? `Removing bundle ${message.name}…`
            : `Uninstalling ${message.name}…`,
        );
        return;
      case 'update':
        this.forgetInstalled(message.kind, message.name, message.scope);
        await this.runAction(
          [updateArgs([message.name])],
          message.scope,
          `Updating ${message.name}…`,
          message.name,
        );
        return;
      case 'complete-install':
        // Materialization drift: `grim install` writes the outputs the record
        // does not cover. NOT `grim update` — that would re-resolve floating
        // tags and roll the lock forward, a version change dressed as a repair.
        // No --force affordance either (offerForcedRetry only appends it for
        // add/update): forcing a whole-lock install would discard local edits
        // to unrelated artifacts. A refusal is named by offerInstallRefusal in
        // runActionInner, which lists the modified artifacts and offers a way in.
        await this.runAction([installArgs()], message.scope, 'Completing install…');
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
      case 'visible':
        // The rows on screen ARE the prefetch work list. The force flag belongs
        // to the results round that produced this render, not to the scroll —
        // consumed once, so a later scroll re-probes only what is stale.
        //
        // Validated and bounded first: this list is webview-supplied, and every
        // element becomes a grim spawn and a cache filename. isValidRepo is the
        // same check the deep-link handler uses; the cap is a sanity ceiling
        // well above any viewport, NOT a return of the fixed top-K this branch
        // deliberately removed.
        this.delegate.prefetch(
          (Array.isArray(message.repos) ? message.repos : [])
            .filter((repo) => typeof repo === 'string' && isValidRepo(repo))
            .slice(0, MAX_VISIBLE_REPOS),
          { force: this.consumeForcePrefetch() },
        );
        return;
      case 'pickVersion':
        this.delegate.expireCached(message.repo);
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
      case 'viewFlags':
        // Mirror the webview's view state into context keys so the title bar's
        // toggles can pick their icon (`when: grimoire.view.compact`, …). The
        // state itself stays webview-side; these are a rendering input only.
        await vscode.commands.executeCommand(
          'setContext',
          'grimoire.view.compact',
          message.flags.compact,
        );
        await vscode.commands.executeCommand(
          'setContext',
          'grimoire.view.tree',
          message.flags.tree,
        );
        await vscode.commands.executeCommand(
          'setContext',
          'grimoire.view.grouped',
          message.flags.grouped,
        );
        await vscode.commands.executeCommand(
          'setContext',
          'grimoire.view.expanded',
          message.flags.anyExpanded,
        );
        // Updates neither trees nor groups, so its title bar drops both
        // controls rather than showing toggles whose effect never appears.
        await vscode.commands.executeCommand(
          'setContext',
          'grimoire.view.structured',
          message.flags.structured,
        );
        return;
      case 'viewPrefs':
        // Deliberate switches only (see the message doc) — a twisty click or a
        // tab change never gets here, so the stored preference is exactly what
        // the user last chose.
        await this.memento.update(VIEW_PREFS_KEY, message.view);
        return;
      case 'showGrimInfo':
        // Opens the grim-info modal (registered in extension.ts). Executed as a
        // command rather than routed through the delegate — it is pure
        // diagnostics with no state to plumb back.
        await vscode.commands.executeCommand('grimoire.showGrimInfo');
        return;
    }
  }

  /** Cache-forget for an action that names an install (kind + name + scope)
   *  rather than a repo: the loaded cards carry that mapping, so no grim call
   *  and no protocol change is needed to find the repo. A card set that no
   *  longer holds the artifact (a stale webview click) simply forgets nothing. */
  private forgetInstalled(kind: string, name: string, scope: Scope): void {
    const cards = [...(this.lastReady?.cards ?? []), ...(this.lastReady?.installed ?? [])];
    const repo = repoForInstall(cards, kind, name, scope);
    if (repo !== null) {
      this.delegate.expireCached(repo);
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
      // A refused Complete Install: scope-wide, so there is no Overwrite to
      // offer (forcing would discard edits to artifacts the user never touched)
      // and offerForcedRetry declines it. Name the modified artifacts instead of
      // leaving a bare toast about one the user has never heard of. After
      // offerForcedRetry, so an anchor-escape refusal still takes that branch.
      // Falls through rather than returning: the notice is not awaited, and the
      // refreshAll below is owed either way — a scope-wide install that stopped
      // at a modified artifact may already have materialized the ones before it.
      if (!offerInstallRefusal(result, args, scope, this.scopes, this.output)) {
        // Name the failing step — an init→add sequence can fail halfway.
        reportGrimFailure(result, this.output, `grim ${args[0]}`);
      }
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
      if (this.refreshing === 0 && this.metaRepostPending) {
        this.metaRepostPending = false;
        void this.repostCardMeta(); // replay the signal this refresh swallowed
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
      this.setUpdateCount(0);
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
      this.setUpdateCount(0); // same definite answer as the snapshot's own no-grim above
      this.postState({ phase: 'no-grim', items: [], installed: [] });
      return;
    }
    // Read the registry set off the scope the search ACTUALLY used, not global:
    // a project with its own `[[registries]]` browses those, and reporting
    // global's set made the view name registries it never read (and miss the
    // ones it did). Falls back to global when project scope has no context —
    // the same fallback searchScopeFor itself makes.
    const searchScope = searchScopeFor(snap.projectFolder, projectSearchable(snap));
    const searchContext =
      (searchScope === 'project' ? snap.project?.context : undefined) ?? snap.global?.context;
    const defaultRegistry = searchContext?.default_registry;
    this.lastDefaultRegistry = defaultRegistry ? registryUrlHost(defaultRegistry) : undefined;
    this.lastRegistries = (searchContext?.registries ?? []).map((r) => ({
      alias: r.alias,
      oci: r.url,
      // grim's kind vocabulary is open; anything that is not the index kind is
      // treated as a plain registry, which is the prefix-matchable case.
      kind: r.kind === 'index' ? ('index' as const) : ('registry' as const),
      isDefault: r.default,
      ...(r.authenticated === true ? { authenticated: true } : {}),
    }));
    const authed = authenticatedHosts(searchContext?.registries ?? []);
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
    await this.enrichCards(cards);
    await this.enrichCards(installed);
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
      this.setUpdateCount(updateCount(scopeStatus));
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
    // The webview reports which rows are actually on screen and that drives the
    // sweep from here on ('visible' above). Seeding the first screenful anyway
    // costs one superseded queue — the generation guard drops it as soon as the
    // real viewport lands — and keeps logos filling if a webview never reports.
    // Skip on error results.
    if (catalogError === undefined) {
      // An explicit refresh/check re-resolves the cached describes too: they are
      // where an index-backed row's version comes from, and a TTL-fresh entry
      // would otherwise outlive several deliberate refreshes.
      this.forcePrefetch = options.refresh === true || options.check === true;
      this.delegate.prefetch(
        cards.slice(0, SEED_SWEEP).map((c) => c.repo),
        { force: this.forcePrefetch },
      );
    }
  }

  /** The single write point for the outdated count that rolls up into the
   *  activity-bar icon's number — which must mean "updates available", not
   *  "artifacts installed". Cleared at zero. Also the only writer of
   *  `grimoire.updatesAvailable`, the key gating the conditional Update All
   *  toolbar icon, so badge and icon cannot disagree.
   *
   *  The count is held here and re-applied from resolveWebviewView, because a
   *  WebviewView's badge only exists once VS Code resolves the view (deferred
   *  until it first becomes visible): in a window where Grimoire was never
   *  opened there is no badge to show a count on, and opening it later must not
   *  wait for the next refresh to get one. */
  setUpdateCount(count: number): void {
    if (count === this.badgeCount) {
      // Every refresh publishes a count, and most refreshes publish the same
      // one — a watcher storm would otherwise fire a context-key command per
      // event for no visible change.
      return;
    }
    this.badgeCount = count;
    void vscode.commands.executeCommand('setContext', 'grimoire.updatesAvailable', count > 0);
    this.applyBadge();
  }

  /** Test seam: the count currently published (0 = no badge). */
  updateCount(): number {
    return this.badgeCount;
  }

  private applyBadge(): void {
    if (!this.view) {
      return;
    }
    // One wording for the count, shared with the Updates tab's own heading —
    // "1 available" hanging over "1 update available" reads as two counts in
    // two different units.
    this.view.badge =
      this.badgeCount > 0
        ? {
            value: this.badgeCount,
            tooltip:
              this.badgeCount === 1 ? '1 update available' : `${this.badgeCount} updates available`,
          }
        : undefined;
  }

  /** Sets card.logoUri and — for a card the catalog gave no version — its
   *  latestVersion from the details cache (misses stay codicon tiles / blank).
   *
   *  The version fallback is what makes index-backed rows show a version at all:
   *  `grim search` reports null `version`/`latest_tag` for every repo behind an
   *  index (a phone book carries no tags), so the row's only source is the live
   *  describe the prefetch already caches. A catalog-supplied version always
   *  wins — it is the same round's answer, not a snapshot of an older one.
   *
   *  ponytail: rides the existing prefetch, so it reaches its top-K and honors
   *  grimoire.prefetchDetails. Rows past that ceiling stay blank — give them a
   *  describe-only sweep if the catalogs get big enough to notice. */
  private consumeForcePrefetch(): boolean {
    const force = this.forcePrefetch;
    this.forcePrefetch = false;
    return force;
  }

  private async enrichCards(cards: CardVM[]): Promise<void> {
    if (cards.length === 0) {
      return;
    }
    applyCardMeta(cards, await this.delegate.cachedCardMeta(cards.map((c) => c.repo)));
  }

  /** Re-enriches the last ready result's cards and reposts WITHOUT the loading
   *  flash — pops in logos and versions as prefetches land (debounced by the
   *  prefetcher). */
  async repostCardMeta(): Promise<void> {
    if (this.refreshing > 0) {
      this.metaRepostPending = true; // replayed when the refresh drains
      return;
    }
    const ready = this.lastReady;
    if (!ready) {
      return; // nothing painted yet — the first ready post enriches from cache
    }
    await this.enrichCards(ready.cards);
    await this.enrichCards(ready.installed);
    // Re-check after the await gap: a refresh may have started (or replaced
    // lastReady) while the logo reads were in flight — posting now would emit
    // a stale ready state that cancels the webview's refreshing footer.
    if (this.refreshing > 0) {
      this.metaRepostPending = true;
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
      registries: this.lastRegistries,
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
