// Details editor tabs: one WebviewPanel per repo, revealed on reopen. State
// is rebuilt from grim on every open (and on refreshAll), so panels are not
// retained when hidden. A minimal serializer restores panels across reloads.
import * as vscode from 'vscode';
import {
  addArgs,
  describeArgs,
  fetchArgs,
  initArgs,
  installArgs,
  uninstallNotice,
  uninstallOrRemoveArgs,
  updateArgs,
  type ActionReport,
  type DescFile,
  type DescribeResult,
  type DescriptionResult,
  type DigestResult,
  type FetchResult,
  type Scope,
} from '../grim';
import {
  CACHE_VERSION,
  type CachedCardMeta,
  cardMetaOf,
  paintSignature,
  DetailsCache,
  type DetailsCacheEntry,
  mergeEntry,
} from '../detailsCache';
import type { CatalogService } from '../catalog';
import { projectSearchable, type ScopeService, type Snapshot } from '../scopes';
import {
  artifactName,
  buildDetailsVM,
  buildShareLink,
  buildSkeletonVM,
  computeUpdateAvailable,
  declaredKey,
  findAssetPath,
  isOpenableUrl,
  normalizeKind,
  parseViaBundles,
  refRepo,
  refTag,
  resolveCompanionAssets,
  voteStateAfter,
  type ScopeStatus,
} from '../webview/model';
import type {
  DetailsToHost,
  DetailsVM,
  HostToDetails,
  RevalidateState,
  ScopesVM,
  VoteState,
} from '../webview/protocol';
import { supportsRating } from '../installer';
import { castVote, confirmVote, refineVoteState, type VoteDeps } from './vote';
import { offerRatingCredential } from './ratingAuth';
import type { SecretReader, SecretWriter } from '../auth';
import { notifyError, reportGrimFailure, runWithStatusProgress } from '../notify';
import { esc, renderDetails } from '../webview/render';
import { render } from '@lit-labs/ssr';
import { collectResultSync } from '@lit-labs/ssr/lib/render-result.js';
import { webviewHtml } from './html';
import { scopeStatuses } from './sidebar';
import { pickVersion } from './pickVersion';
import { offerForcedRetry, offerRefusedRetry } from './forceRetry';
import { offerFullUpdate } from './staleLock';
import { switchToReplacement } from './switchReplacement';
import { offerInstallRefusal } from './updateRefusal';

export const DETAILS_VIEW_TYPE = 'grimoire.details';

const LOGO_NAMES = ['logo.png', 'logo.svg', 'icon.png'];
const LOGO_MIME: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
};

/** How long a COMPLETE cached snapshot is trusted before the browse-list
 *  prefetch re-probes it. A plain "is it cached?" filter made the FIRST snapshot
 *  immortal: a package that gained a logo (or README) after it was cached never
 *  showed one on its card, because the prefetcher skipped every repo that had any
 *  entry. The re-probe is one manifest describe per repo (see
 *  {@link DetailsManager.prefetchInto}), not a blob download. */
const PREFETCH_TTL_MS = 6 * 60 * 60 * 1000;

/** The same trust window for a snapshot whose probe partly failed
 *  (DetailsCacheEntry.complete === false). A failed probe used to be stamped
 *  exactly as fresh as a good one, so one network hiccup hid a logo for six
 *  hours — the reported "logos appear on click, then vanish". Missing content
 *  is the case that most deserves a retry, so it gets the shortest one that is
 *  still polite to the registry. */
const RETRY_TTL_MS = 10 * 60 * 1000;

/** How long after a COMPLETE probe an open trusts the entry outright and skips
 *  its own content revalidate.
 *
 *  The viewport prefetch probes the rows the user is looking at — including the
 *  one they are about to click — so the on-open revalidate normally re-ran a
 *  `describe` plus a companion digest probe seconds after the sweep had done
 *  exactly that. Measured against the public index that is ~1.8s of network per
 *  open, spent competing with the sweep's own concurrent spawns, to re-learn a
 *  digest that could not have moved. A minute is short enough that anything the
 *  user might have published themselves is still picked up on the next open.
 *
 *  Much shorter than {@link PREFETCH_TTL_MS} on purpose: that one decides
 *  whether a BACKGROUND sweep bothers, this one whether a deliberate open
 *  double-checks. Only a `complete` entry qualifies — an incomplete one is
 *  precisely the case that deserves the retry. */
const OPEN_REVALIDATE_TTL_MS = 60 * 1000;

const KIND_LABELS: Record<string, string> = {
  skill: 'Skill',
  rule: 'Rule',
  agent: 'Agent',
  mcp: 'MCP',
  bundle: 'Bundle',
};

/** True when a COMPLETE entry was written inside {@link OPEN_REVALIDATE_TTL_MS}.
 *  Pure; exported for the open-path test. A future-dated `savedAt` (clock skew)
 *  and an unparsable one both read as stale, the same direction
 *  {@link DetailsManager.isFresh} takes. */
export function justProbed(entry: DetailsCacheEntry): boolean {
  if (entry.complete !== true) {
    return false;
  }
  const age = Date.now() - Date.parse(entry.savedAt);
  return age >= 0 && age < OPEN_REVALIDATE_TTL_MS;
}

/** Preview-tab title marker: VS Code offers no styling for webview tab titles,
 *  so a plain " (Preview)" suffix stands in; plain title once permanent. */
function tabTitle(base: string, preview: boolean): string {
  return preview ? `${base} (Preview)` : base;
}

export class DetailsManager implements vscode.WebviewPanelSerializer {
  private panels = new Map<string, vscode.WebviewPanel>();
  // Panels disposed mid-build: postVM awaits grim for seconds, and touching
  // panel.webview after disposal THROWS ("Webview is disposed") — which would
  // surface as an error toast out of whatever command ran refreshAll.
  private disposedPanels = new WeakSet<vscode.WebviewPanel>();
  // A single reusable "preview" tab (Extensions-view single-click behavior):
  // retargeted on the next single-click, promoted to `panels` on double-click
  // or on any action performed inside it.
  private preview: { panel: vscode.WebviewPanel; repo: string } | undefined;
  /** Persistent per-repo content snapshot store (stale-while-revalidate). */
  private cache: DetailsCache;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly scopes: ScopeService,
    private readonly catalog: CatalogService,
    private readonly onDidChange: () => Promise<void>,
    private readonly output: vscode.OutputChannel,
    /** Focuses Browse and seeds its search (item 2 rail-tag click); reuses the
     *  same deep-link path the URI handler uses. */
    private readonly searchTag: (tag: string) => Promise<void>,
    /** Absolute dir for the snapshot cache (globalStorageUri/details-cache). */
    cacheDir: string,
    /** Suspends file watchers around a mutating action (its own writes' watcher
     *  events are redundant with the completion refresh). Defaults to a no-op
     *  passthrough so the manager is usable without the wiring. */
    private readonly suspendWhile: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
    /** Fired (from the single {@link saveEntry} choke point) whenever a cache
     *  write carries something a card renders — a logo or a resolved latest
     *  version — so the sidebar can pop it into its cards. Every save path
     *  counts: opening a details panel caches both exactly like the background
     *  prefetch does, and only the prefetch used to report them. */
    private readonly onCardMetaCached: () => void = () => {},
    /** SecretStorage, for the manual-PAT half of the vote credential ladder.
     *  Read on the ladder itself (never written there); the write half is used
     *  ONLY by the "Store Token…" offer a failed vote makes — a deliberate user
     *  action, never something the credential resolution does behind their
     *  back. Defaults to "no stored token, writes go nowhere" so the manager
     *  stays usable unwired — the safe direction: an unwired manager pipes
     *  nothing rather than reaching for a credential it cannot prove belongs to
     *  the host. */
    private readonly secrets: SecretReader & SecretWriter = {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
    },
  ) {
    this.cache = new DetailsCache(cacheDir);
  }

  /**
   * The viewer's own vote per repo — Invariant R-3's storage, and deliberately
   * a sparse map of a THREE-state value rather than a set of "voted" repos.
   * An absent key is `'unknown'`, not "not voted": a set would collapse the
   * two, and every read would have to invent the difference back.
   *
   * Written only from a mutation grim reported as successful (C-008 rule 1) —
   * a failure leaves the key untouched, so a vote that may or may not have
   * landed keeps reading unknown. In-memory only: grim owns the durable record
   * (`votes.json`), and it exposes no read for it, so a fresh window starts
   * unknown exactly as S-008 describes.
   *
   * `up` rides along because the mutation response is authoritative for the
   * count too: the index sidecar this VM's rating came from is regenerated on
   * the index's own schedule, so a rebuilt VM would otherwise snap the count
   * back to its pre-vote value the moment the panel repaints.
   */
  private readonly votes = new Map<string, { vote: VoteState; up: number | null }>();

  /** Repos the silent `viewer_up` refinement has already been attempted for.
   *  Separate from {@link votes} because a refinement that answered *unknown*
   *  stores nothing there — without this it would re-run on every repaint. */
  private readonly refined = new Set<string>();

  /** Test seam: isolate the snapshot cache in a per-test directory. */
  setCacheDir(dir: string): void {
    this.cache = new DetailsCache(dir);
  }

  /** Opens (or promotes to) a permanent tab — command, deep link, double-click. */
  open(repo: string): void {
    const existing = this.panels.get(repo);
    if (existing) {
      existing.reveal();
      return;
    }
    if (this.preview?.repo === repo) {
      // Promote the hovered preview into a permanent tab (no reload/flicker);
      // drop the "(Preview)" title marker now that it's pinned.
      const panel = this.preview.panel;
      this.preview = undefined;
      this.panels.set(repo, panel);
      panel.title = this.titleFor(repo, false);
      panel.reveal();
      return;
    }
    const panel = this.createPanel(repo, false);
    this.panels.set(repo, panel);
    void this.attach(repo, panel);
  }

  /** Opens the shared preview tab (single-click); keeps sidebar focus. */
  openPreview(repo: string): void {
    const existing = this.panels.get(repo);
    if (existing) {
      existing.reveal(undefined, true);
      return;
    }
    if (this.preview?.repo === repo) {
      // Same repo re-clicked (e.g. the second click of a double-click, now that
      // the sidebar posts single-clicks without a disambiguation delay): the
      // content is already painted — just reveal, no repaint/revalidate churn.
      this.preview.panel.reveal(undefined, true);
      return;
    }
    if (this.preview) {
      // Retarget the one reusable tab in place. Title + icon are set from the
      // catalog now (item 6) so they don't swap in after the fetch. Crucially we
      // do NOT reassign webview.html — that reboots the whole webview (script
      // re-parse, codicon reload, markdown-it re-init, ready round-trip) on every
      // preview navigation. Instead paint() swaps the content through messages
      // into the live webview; the webview resets its per-panel UI when the
      // incoming VM's repo changes (see details/main.ts).
      this.preview.repo = repo;
      const panel = this.preview.panel;
      panel.title = this.titleFor(repo, true);
      panel.iconPath = this.iconUri();
      panel.reveal(undefined, true);
      void this.paint(repo, panel);
      return;
    }
    const panel = this.createPanel(repo, true);
    this.preview = { panel, repo };
    void this.attach(repo, panel);
  }

  /** Test seam: repos with a permanent panel. */
  get openRepos(): string[] {
    return [...this.panels.keys()];
  }

  /** Test seam: the repo currently shown in the reusable preview slot. */
  get previewRepo(): string | null {
    return this.preview?.repo ?? null;
  }

  /** Test seam: the panel object backing the reusable preview slot (to assert its
   *  webview.html is not reassigned across retargets). */
  get previewPanel(): vscode.WebviewPanel | undefined {
    return this.preview?.panel;
  }

  async deserializeWebviewPanel(
    panel: vscode.WebviewPanel,
    state: { repo?: string } | undefined,
  ): Promise<void> {
    const repo = state?.repo;
    if (!repo) {
      panel.dispose();
      return;
    }
    // Defensively re-assert the webview options createPanel sets — a restored
    // panel is not guaranteed to carry them, and the webview needs scripts +
    // the dist/webview resource root to load.
    panel.webview.options = this.webviewOptions();
    // Serialized panels always restore as permanent.
    this.panels.set(repo, panel);
    await this.attach(repo, panel);
  }

  private webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
  }

  private createPanel(repo: string, preview: boolean): vscode.WebviewPanel {
    // Title + icon are known from the catalog at creation (item 6), so the tab
    // shows "Kind: name" and the logo immediately — no swap after the fetch. A
    // preview (single-click) tab carries a " (Preview)" suffix — VS Code has no
    // preview API for webview panels.
    const panel = vscode.window.createWebviewPanel(
      DETAILS_VIEW_TYPE,
      this.titleFor(repo, preview),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: preview },
      this.webviewOptions(),
    );
    panel.iconPath = this.iconUri();
    return panel;
  }

  /** "Kind: name" from the catalog search item; the repo tail when it misses.
   *  The preview slot appends " (Preview)" — see {@link tabTitle}. */
  private titleFor(repo: string, preview: boolean): string {
    const item = this.catalog.state().items.find((i) => i.repo === repo);
    const kind = normalizeKind(item?.kind ?? null);
    const base = kind ? `${KIND_LABELS[kind] ?? kind}: ${artifactName(repo)}` : artifactName(repo);
    return tabTitle(base, preview);
  }

  private iconUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo.png');
  }

  /** The panel's server-side first paint. With a cached snapshot on disk this is
   *  the REAL page — header, logo, install rows, README, changelog — inlined into
   *  webview.html, so the content is in the first HTML parse instead of waiting
   *  for the bundle to parse, register its elements and post `ready`. That round
   *  trip was the whole of "details is slow though everything is cached": the
   *  SWR paint in {@link paint} was already instant, it just could not start
   *  until the webview existed. Without an entry (or without a scope snapshot to
   *  read install state from) it falls back to the skeleton, exactly as before.
   *
   *  renderDetails returns a lit TemplateResult; @lit-labs/ssr renders it to the
   *  same markup string the webview's first lit render produces (the host bundle
   *  is platform:node, so lit-html's Node/SSR export conditions resolve).
   *  collectResultSync keeps this synchronous — the template has no async
   *  directives — so only the cache read above it is awaited. */
  private renderHtml(
    panel: vscode.WebviewPanel,
    repo: string,
    cached: DetailsCacheEntry | null,
  ): string {
    const snapshot = this.scopes.cachedSnapshot();
    // Same guard skeletonVM applies to its own install boxes: a snapshot with
    // neither scope cannot say what is installed, and vmFromCache would render
    // that silence as a positive "Not installed".
    const vm =
      cached && snapshot && (snapshot.project || snapshot.global)
        ? this.vmFromCache(repo, cached, snapshot)
        : this.skeletonVM(repo);
    return webviewHtml(
      panel.webview,
      this.extensionUri,
      'details',
      `data-repo="${esc(repo)}"`,
      collectResultSync(render(renderDetails(this.stampVM(panel, vm)))),
    );
  }

  /** Resolves the panel's current repo (the preview tab is retargeted in place). */
  private repoOf(panel: vscode.WebviewPanel): string | undefined {
    if (this.preview?.panel === panel) {
      return this.preview.repo;
    }
    for (const [repo, candidate] of this.panels) {
      if (candidate === panel) {
        return repo;
      }
    }
    return undefined;
  }

  /** Wires a freshly created panel and gives it its one html assignment.
   *
   *  Async because the first paint reads the details cache (see
   *  {@link renderHtml}) — so `panel.webview.html` is populated a disk read
   *  after the caller returns, not before it. The listeners below are still
   *  registered synchronously, which is what actually matters: `ready` is only
   *  reachable once html boots the webview, so it can never be missed. */
  private async attach(repo: string, panel: vscode.WebviewPanel): Promise<void> {
    // html is assigned exactly ONCE per panel (reassigning it reboots the
    // webview — a tested invariant).
    panel.onDidDispose(() => {
      this.disposedPanels.add(panel);
      if (this.preview?.panel === panel) {
        this.preview = undefined;
        return;
      }
      for (const [candidateRepo, candidate] of this.panels) {
        if (candidate === panel) {
          this.panels.delete(candidateRepo);
        }
      }
    });
    panel.webview.onDidReceiveMessage((message: DetailsToHost) => {
      const current = this.repoOf(panel);
      if (current) {
        void this.onMessage(current, panel, message);
      }
    });
    const cached = await this.cache.load(repo).catch(() => null);
    if (this.disposedPanels.has(panel)) {
      return; // closed during the read; touching webview.html would throw
    }
    // A preview retarget inside that read would make this the wrong artifact's
    // markup. paint() reposts for whichever repo the panel tracks now, so paint
    // THAT one and drop the entry we loaded for the other.
    const current = this.repoOf(panel) ?? repo;
    panel.webview.html = this.renderHtml(panel, current, current === repo ? cached : null);
  }

  /** Re-sends fresh view models to every open panel (after installs etc.),
   *  including the reusable preview slot. postVM re-checks the panel's repo, so
   *  a preview retargeted mid-refresh discards the stale VM. */
  /** Locks (title) or unlocks (null) the action controls of EVERY open panel
   *  while a grim run is in flight anywhere — see notify.ts's onBusyChange. The
   *  acting panel posts its own busy title first (actionInner, for immediate
   *  feedback); this is what reaches the others. */
  setBusy(busy: string | null): void {
    for (const panel of [...this.panels.values(), this.preview?.panel]) {
      if (panel && !this.disposedPanels.has(panel)) {
        void panel.webview.postMessage({ type: 'busy', action: busy } satisfies HostToDetails);
      }
    }
  }

  async refreshOpenPanels(options: { check?: boolean } = {}): Promise<void> {
    for (const [repo, panel] of this.panels) {
      if (!this.disposedPanels.has(panel)) {
        await this.postVM(repo, panel, options);
      }
    }
    if (this.preview && !this.disposedPanels.has(this.preview.panel)) {
      await this.postVM(this.preview.repo, this.preview.panel, options);
    }
  }

  /** Instant skeleton VM from the catalog + last-known snapshot, so the header and
   *  install boxes show before grim fetch/describe resolve. Shared by the inline
   *  server-side skeleton ({@link renderHtml}) and the on-ready post
   *  ({@link postSkeleton}) so both render identically. */
  private skeletonVM(repo: string): DetailsVM {
    const searchItem = this.catalog.state().items.find((i) => i.repo === repo) ?? null;
    const cached = this.scopes.cachedSnapshot();
    const folder = this.scopes.projectFolder();
    const scopes: ScopesVM = {
      projectOpen: folder !== undefined,
      projectConfigured: cached ? projectSearchable(cached) : false,
      projectName: folder ? (folder.split(/[\\/]/).pop() ?? null) : null,
    };
    // A snapshot is almost always cached by the time a panel opens (the sidebar
    // fetches one at activation), so the Project/Global boxes show real install
    // state immediately; without one they render pending shells (spinner per
    // box) until the full VM from postVM lands ~1s later.
    const statuses = cached ? scopeStatuses(cached) : [];
    const { installs, unknown } = installState(repo, statuses);
    // No cached snapshot (or no scope in it): pass undefined so the scope boxes
    // render pending shells rather than a positive "Not installed".
    const vm = buildSkeletonVM(
      repo,
      searchItem as never,
      scopes,
      cached && (cached.project || cached.global) ? installs : undefined,
    );
    // Stamped rather than threaded through the builder (same posture as
    // postArtifact's isPreview): a scope the cached snapshot could not read must
    // render as unknown here too, not as "Not installed".
    if (unknown.length > 0) {
      vm.unknownScopes = unknown;
    }
    return vm;
  }

  /** Posts the instant skeleton VM so the header shows before grim fetch/describe
   *  resolve; the full VM from postVM replaces it. */
  private postSkeleton(repo: string, panel: vscode.WebviewPanel): void {
    this.postArtifact(panel, this.skeletonVM(repo));
  }

  /** Posts an artifact VM, stamping whether the panel is the reusable preview
   *  slot (drives the header Pin / promote affordances). Single choke point so
   *  isPreview is always current at post time. */
  private postArtifact(panel: vscode.WebviewPanel, vm: DetailsVM): void {
    if (this.disposedPanels.has(panel)) {
      return;
    }
    void panel.webview.postMessage({
      type: 'artifact',
      vm: this.stampVM(panel, vm),
    } satisfies HostToDetails);
  }

  /** The per-panel fields no builder can know: whether this panel is the reusable
   *  preview slot, this session's vote, and whether voting is supported at all.
   *
   *  Shared by {@link postArtifact} and the server-side first paint
   *  ({@link renderHtml}) so the SSR'd markup and the first posted VM cannot
   *  disagree about them. `?? 'unknown'` is the whole of R-3's default: an
   *  artifact this window has not voted on in this session has an UNKNOWN vote,
   *  because the user may well have voted elsewhere. */
  private stampVM(panel: vscode.WebviewPanel, vm: DetailsVM): DetailsVM {
    vm.isPreview = this.preview?.panel === panel;
    const voted = this.votes.get(vm.repo);
    if (vm.rating) {
      vm.rating = {
        ...vm.rating,
        vote: voted?.vote ?? 'unknown',
        up: voted?.up ?? vm.rating.up,
      };
    }
    vm.canVote = this.ratingSupported();
    return vm;
  }

  /** Builds (full pipeline) and posts the VM; syncs the editor tab title + icon
   *  (design 1c). Used after actions and on refresh — the SWR open path posts
   *  via {@link paint}/{@link postBuilt} so it can reuse a pre-built VM. */
  private async postVM(
    repo: string,
    panel: vscode.WebviewPanel,
    options: { check?: boolean } = {},
  ): Promise<void> {
    await this.postBuilt(repo, panel, await this.buildVM(repo, options));
  }

  /** Posts an already-built VM to a panel, syncing its title + icon. */
  private async postBuilt(repo: string, panel: vscode.WebviewPanel, vm: DetailsVM): Promise<void> {
    // The preview slot can be retargeted while a build awaits; if this panel now
    // tracks a different repo, drop the stale VM so B's document isn't titled for
    // A. (undefined = untracked panel, e.g. a test double — post as asked.)
    const current = this.repoOf(panel);
    if (current !== undefined && current !== repo) {
      return;
    }
    // Disposed while the build awaited grim: touching the panel would throw.
    if (this.disposedPanels.has(panel)) {
      return;
    }
    // Rebuild the title from the (fresher) VM, preserving the "(Preview)" marker
    // while this panel is still the reusable preview slot.
    const base = vm.kind ? `${KIND_LABELS[vm.kind] ?? vm.kind}: ${vm.name}` : vm.name;
    panel.title = tabTitle(base, this.preview?.panel === panel);
    panel.iconPath = this.iconUri();
    this.postArtifact(panel, vm);
  }

  /**
   * The /vote deep link's entry point: upvote the artifact the caller has just
   * opened. Cast only — a link can never retract (see extension.ts).
   *
   * Takes the panel from {@link open}'s own map rather than a parameter, for
   * the same reason `onMessage` uses `repoOf(panel)`: the panel a vote repaints
   * is resolved here, never supplied by the thing that asked for the vote. No
   * panel means `open()` bailed on a disposed one — nothing to vote from.
   *
   * Runs before the webview has posted `ready`, deliberately: the busy post it
   * may miss is cosmetic, and the eventual first paint reads the host-side
   * `votes` map this has already written.
   */
  async voteFromLink(repo: string): Promise<void> {
    const panel = this.panels.get(repo);
    if (!panel) {
      return;
    }
    await this.vote(repo, panel, false);
  }

  /** Public for tests: the webview message entry point. */
  async onMessage(repo: string, panel: vscode.WebviewPanel, message: DetailsToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.paint(repo, panel);
        // After the paint, never before it: the panel shows its (neutral,
        // unknown) rating immediately and refines in the background.
        await this.refineVote(repo, panel);
        return;
      case 'openDetails':
        // Details→details navigation respects preview semantics (not a new
        // permanent tab): openPreview reveals an already-open panel, navigates
        // the preview slot in place when this click came from it, or opens the
        // target in the preview slot otherwise — the same singleton-slot
        // machinery a sidebar single-click uses. Deep links / commands still
        // use open() for a permanent tab.
        this.openPreview(message.repo);
        return;
      case 'pickVersion':
        // repo is repoOf(panel) — authoritative, same trust rule as 'install'.
        await this.suspendWhile(() =>
          pickVersion(repo, this.scopes, this.output, this.onDidChange, message.scope),
        );
        return;
      case 'install': {
        // repo is repoOf(panel) — authoritative. The webview no longer supplies
        // a ref, so a compromised webview can't redirect the install target.
        // Installing into an unconfigured project needs grimoire.toml first:
        // `grim add` there errors (not-found, exit 79) before any network, so
        // run `grim init` then `grim add` as one host-side step (item 1).
        // projectNeedsInit (not !projectConfigured): a FAILED probe must not
        // trigger init — see the method's doc.
        const needsInit = message.scope === 'project' && (await this.scopes.projectNeedsInit());
        const steps = needsInit ? [initArgs(), addArgs(repo)] : [addArgs(repo)];
        await this.action(repo, panel, steps, message.scope, 'Installing…');
        return;
      }
      case 'update':
        await this.action(
          repo,
          panel,
          [updateArgs([message.name])],
          message.scope,
          'Updating…',
          message.name,
        );
        return;
      case 'uninstall':
        await this.action(
          repo,
          panel,
          [uninstallOrRemoveArgs(message.kind, message.name)],
          message.scope,
          message.kind === 'bundle' ? 'Removing bundle…' : 'Uninstalling…',
        );
        return;
      case 'complete-install':
        // Materialization drift: `grim install` writes the outputs the record
        // does not cover, for the whole scope — install cannot target one
        // artifact, and `update` would roll the lock forward instead of
        // repairing it. See the sidebar host for why no --force is offered.
        await this.action(repo, panel, [installArgs()], message.scope, 'Completing install…');
        return;
      case 'switch': {
        // Host-authoritative: the single banner button means "all installed
        // scopes", so derive the scope set + install identity from the snapshot
        // for repoOf(panel) — never the webview — matching the install posture.
        // Only `replacedBy` (grim-validated) is taken from the message. Skip
        // bundle-held rows: their old copy can't be removed here (kept-by-bundle).
        const snapshot = this.scopes.cachedSnapshot() ?? (await this.scopes.snapshot());
        const targets = installState(repo, scopeStatuses(snapshot))
          .installs.filter((i) => i.viaBundles.length === 0)
          .map((i) => ({ scope: i.scope, kind: i.kind, name: i.name }));
        await switchToReplacement({
          scopes: this.scopes,
          targets,
          replacedBy: message.replacedBy,
          output: this.output,
          suspendWhile: this.suspendWhile,
          onDone: () => this.onDidChange(),
        });
        return;
      }
      case 'openExternal':
        // Web links plus `mailto:` for the SUPPORT panel's contact channel —
        // re-checked here rather than trusted from the webview.
        if (isOpenableUrl(message.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
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
      case 'searchTag':
        await this.searchTag(message.tag);
        return;
      case 'revalidateError': {
        // repo is repoOf(panel) — authoritative; the message comes from our own
        // store, never the webview.
        const failure = this.lastFailure.get(repo) ?? 'Refresh failed — showing cached data';
        const choice = await vscode.window.showWarningMessage(failure, 'Show Output');
        if (choice === 'Show Output') {
          this.output.show();
        }
        return;
      }
      case 'promote':
        // Pin button / body double-click substitute for the tab-strip
        // double-click VS Code offers no webview API for. open() promotes the
        // preview slot to a permanent tab (drops the " (Preview)" marker); the
        // 'promoted' post clears the header pin. No-op when already permanent.
        this.open(repo);
        void panel.webview.postMessage({ type: 'promoted' } satisfies HostToDetails);
        return;
      case 'vote':
        // repo is repoOf(panel) — authoritative, same trust rule as 'install'.
        // The webview supplies only the DIRECTION, and the resulting state is
        // read back off grim's own report rather than assumed from it.
        await this.vote(repo, panel, message.remove);
        return;
    }
  }

  /** Public: also the /vote deep link's gate. True when the resolved grim is
   *  new enough to have `grim rate`. Read off
   *  the cached context probe — no extra spawn — and false when nothing is
   *  cached yet, which hides the affordance until the first snapshot lands
   *  rather than offering a button an older grim would reject with exit 64. */
  ratingSupported(): boolean {
    const snapshot = this.scopes.cachedSnapshot();
    const version = snapshot?.project?.context.version ?? snapshot?.global?.context.version;
    return version !== undefined && supportsRating(version);
  }

  /**
   * Ask grim, silently, whether this user already voted (C-023 / S-008) — the
   * lazy refinement that lets a detail view improve on "unknown".
   *
   * Skipped entirely when the artifact is unrated, when grim is too old, or
   * when this repo was already tried in this window. A result of `'unknown'`
   * is recorded as *attempted* but not as state, so the display stays neutral
   * and the query does not repeat on every repaint.
   */
  private async refineVote(repo: string, panel: vscode.WebviewPanel): Promise<void> {
    if (this.refined.has(repo) || this.votes.has(repo) || !this.ratingSupported()) {
      return;
    }
    // Unrated rows have no thread to ask about; skip before spawning grim.
    if (!this.catalog.state().items.find((i) => i.repo === repo)?.rating) {
      return;
    }
    this.refined.add(repo);
    const vote = await refineVoteState(
      { run: (args, scope, stdin) => this.scopes.run(args, scope, stdin), secrets: this.secrets },
      repo,
    );
    if (vote === 'unknown') {
      // Nothing learned. Leave the map empty so the display stays neutral —
      // recording 'unknown' as a value would say the same thing, less clearly.
      return;
    }
    this.votes.set(repo, { vote, up: null });
    this.postArtifact(panel, await this.buildVM(repo));
  }

  /**
   * Cast or retract the viewer's vote, then repaint from the mutation response
   * alone — S-007: the response is authoritative and no second query follows.
   *
   * The failure branch is the one that matters. It records NOTHING, so the
   * repo's vote state stays whatever it was (unknown, for a first vote). A
   * vote that failed after the request left may well have landed on the forge;
   * writing "not voted" here would be a guess presented as a fact, and would
   * invite a second click that silently toggles the first vote back off.
   */
  private async vote(repo: string, panel: vscode.WebviewPanel, remove: boolean): Promise<void> {
    const deps: VoteDeps = {
      run: (args, scope, stdin) => this.scopes.run(args, scope, stdin),
      secrets: this.secrets,
      confirm: confirmVote,
    };
    const busy = remove ? 'Retracting vote…' : 'Voting…';
    void panel.webview.postMessage({ type: 'busy', action: busy } satisfies HostToDetails);
    const outcome = await this.suspendWhile(() =>
      runWithStatusProgress(busy.replace(/…$/, ''), () => castVote(deps, repo, remove)),
    );
    if (outcome.ok) {
      this.refined.add(repo);
      this.votes.set(repo, {
        vote: voteStateAfter(outcome.report),
        up: outcome.report.up,
      });
    } else if (outcome.credential !== undefined) {
      // No credential for the host grim named. The message alone used to be the
      // end of it, naming two remedies neither of which the extension offered —
      // so it carries the reason now and the offer matches it.
      void offerRatingCredential(outcome.credential, outcome.message, this.secrets);
    } else if (outcome.message !== '') {
      // An empty message is the user declining the disclosure — nothing
      // happened and nothing needs saying. Everything else is a real failure,
      // and NOTHING is recorded for it: the state stays exactly as it was.
      void vscode.window.showWarningMessage(outcome.message);
    }
    // Repaint either way — this is also what clears the busy state.
    await this.onDidChange();
    await this.postVM(repo, panel);
  }

  /** Runs one or more grim commands in sequence (e.g. init then add), stopping
   *  at the first failure; notices/onDidChange fire off the last step. Watchers
   *  are suspended for the whole action — its own writes' events are redundant
   *  with the onDidChange refresh it ends in. */
  private async action(
    repo: string,
    panel: vscode.WebviewPanel,
    steps: string[][],
    scope: Scope,
    busy: string,
    /** Artifact name for stale-lock recovery; set only by per-name update. */
    staleLockName?: string,
  ): Promise<void> {
    // Deliberately does NOT forget the cached entry first. That was tried, on
    // the theory that a post-action probe could fold an older version's content
    // under a newer header. It can — but it could already, before the action:
    // install, update, uninstall and complete-install are all LOCAL, and none of
    // them changes what the registry serves for this repo. The post-action probe
    // is just another revalidate, and folding a partly-failed revalidate over
    // cached content is Ruling 2, the whole design of this branch. The merge can
    // only re-show content the panel was already painting.
    //
    // Forgetting, by contrast, leaves mergeEntry nothing to fold, so a partly
    // failed probe repaints the nulls this branch exists to stop showing — on
    // the one path the user is watching. Version switching never comes through
    // here anyway; it runs pickVersion directly.
    await this.suspendWhile(() => this.actionInner(repo, panel, steps, scope, busy, staleLockName));
  }

  private async actionInner(
    repo: string,
    panel: vscode.WebviewPanel,
    steps: string[][],
    scope: Scope,
    busy: string,
    staleLockName?: string,
  ): Promise<void> {
    // Acting inside a preview pins it (VS Code convention); drop the marker.
    if (this.preview?.panel === panel) {
      this.panels.set(this.preview.repo, panel);
      this.preview = undefined;
      panel.title = this.titleFor(repo, false);
    }
    // The header goes inert (busy class); long grim runs also show status-bar
    // progress. The busy title (e.g. "Installing…") doubles as the status label.
    void panel.webview.postMessage({ type: 'busy', action: busy } satisfies HostToDetails);
    await runWithStatusProgress(busy.replace(/…$/, ''), async () => {
      let last: ActionReport | undefined;
      for (const args of steps) {
        const result = await this.scopes.run<ActionReport>(args, scope);
        if (!result.ok) {
          // A stale-lock update offers a full re-resolve instead of the error
          // toast; postVM still runs below to clear the busy state and re-render.
          if (
            staleLockName !== undefined &&
            (await offerFullUpdate(result, staleLockName, scope, this.scopes, this.output, () =>
              this.onDidChange(),
            ))
          ) {
            await this.postVM(repo, panel);
            return;
          }
          // A forceable drift refusal offers an Overwrite confirm; an anchor-escape
          // refusal gets a non-modal notice with no override — both handled instead
          // of the plain error toast below. The modal opens over the active
          // progress notification (this runs inside runWithStatusProgress), same
          // as offerFullUpdate above.
          if (
            await offerForcedRetry(result, args, scope, this.scopes, this.output, () =>
              this.onDidChange(),
            )
          ) {
            await this.postVM(repo, panel);
            return;
          }
          // A refused Complete Install: scope-wide, so there is no Overwrite to
          // offer (forcing would discard edits to artifacts the user never
          // touched) and offerForcedRetry declines it. Name the modified
          // artifacts instead of leaving a bare toast about one the user has
          // never heard of. After offerForcedRetry, so anchor-escape still wins.
          const refused = offerInstallRefusal(result, args, scope, this.scopes, this.output);
          if (!refused) {
            // Name the failing step — an init→add sequence can fail halfway.
            reportGrimFailure(result, this.output, `grim ${args[0]}`);
          }
          // Refresh the views even on failure, then clear the busy state. Any
          // failure can leave state behind — an earlier step in the sequence
          // (init creating grimoire.toml), or a scope-wide install that stopped
          // partway, having already written every artifact it reached first.
          // Unconditional, matching sidebar.ts's runActionInner: gating this on
          // "an earlier step succeeded" is narrower than the reason for it, and
          // left the two hosts disagreeing on identical input.
          await this.onDidChange();
          await this.postVM(repo, panel);
          return;
        }
        // grim >= 0.13.0 reports a refused update as a NORMAL report (exit 65,
        // `refused` on the row), so it never reaches the failure branch above.
        // Inside the step loop, where this step's argv is still in hand; the
        // modal opens over the active progress notification, exactly as
        // offerForcedRetry's does. No early return — the onDidChange/postVM
        // below are owed either way, since the refused row's pin moved.
        await offerRefusedRetry(result.value, args, scope, this.scopes, this.output);
        last = result.value;
      }
      const notice = last ? uninstallNotice(last) : null;
      if (notice) {
        void vscode.window.showInformationMessage(`Grimoire: ${notice}`);
      }
      await this.onDidChange();
      await this.postVM(repo, panel);
    });
  }

  private async describe(repo: string): Promise<DescribeResult | null> {
    // On failure the details page simply keeps the affected fields null.
    const result = await this.scopes.run<DescribeResult>(describeArgs(repo), 'global');
    return result.ok ? result.value : null;
  }

  private async fetchLogo(
    repo: string,
    files: { path: string }[] | undefined,
  ): Promise<string | null> {
    const logoPath = findAssetPath(files, LOGO_NAMES);
    if (!logoPath) {
      return null;
    }
    const result = await this.scopes.run<FetchResult>(
      fetchArgs(repo, { path: logoPath }),
      'global',
    );
    if (!result.ok) {
      return null;
    }
    const ext = logoPath.split('.').pop()?.toLowerCase() ?? 'png';
    const mime = LOGO_MIME[ext] ?? 'image/png';
    if (result.value.encoding === 'base64') {
      return `data:${mime};base64,${result.value.content}`;
    }
    if (ext === 'svg') {
      return `data:${mime};base64,${Buffer.from(result.value.content, 'utf8').toString('base64')}`;
    }
    return null;
  }

  /** Fetches a well-known markdown doc (README.md / CHANGELOG.md) when the
   *  package ships one; null otherwise. */
  private async fetchDoc(
    repo: string,
    files: { path: string }[] | undefined,
    name: string,
  ): Promise<string | null> {
    const docPath = findAssetPath(files, [name]);
    if (!docPath) {
      return null;
    }
    const result = await this.scopes.run<FetchResult>(fetchArgs(repo, { path: docPath }), 'global');
    if (!result.ok || result.value.encoding === 'base64') {
      return null;
    }
    return result.value.content;
  }

  /** Fetches the in-tree well-known docs/logo against the artifact's own files[]
   *  (the fallback layer under any companion). `want` skips the members a
   *  companion already supplied so v2 makes no redundant --path calls. */
  private async inTreeDocs(
    repo: string,
    fetchValue: FetchResult | null,
    want: { logo: boolean; readme: boolean; changelog: boolean } = {
      logo: true,
      readme: true,
      changelog: true,
    },
  ): Promise<CompanionDocs> {
    if (!fetchValue) {
      return { logoUri: null, readme: null, changelog: null };
    }
    const [logoUri, readme, changelog] = await Promise.all([
      want.logo ? this.fetchLogo(repo, fetchValue.files) : Promise.resolve(null),
      want.readme ? this.fetchDoc(repo, fetchValue.files, 'readme.md') : Promise.resolve(null),
      want.changelog
        ? this.fetchDoc(repo, fetchValue.files, 'changelog.md')
        : Promise.resolve(null),
    ]);
    return { logoUri, readme, changelog };
  }

  /** v2 companion (`fetch --description`): one report with every member inline,
   *  so README/logo/changelog are extracted without any --path follow-ups. In-tree
   *  docs fill only what the companion omitted (precedence companion > in-tree). */
  private async v2Companion(
    repo: string,
    fetchValue: FetchResult | null,
  ): Promise<CompanionDocs & { companionDigest: string | null }> {
    const result = await this.scopes.run<DescriptionResult>(
      fetchArgs(repo, { description: true }),
      'global',
    );
    if (!result.ok) {
      // has_description was true but the companion fetch failed — degrade to
      // in-tree docs with no companion digest; revalidate will retry.
      return { ...(await this.inTreeDocs(repo, fetchValue)), companionDigest: null };
    }
    const files = result.value.files;
    // Both markdown bodies can reference companion images — rewrite refs on each.
    const rawReadme = docFromDescFiles(files, 'readme.md');
    const companionReadme = rawReadme !== null ? resolveCompanionAssets(rawReadme, files) : null;
    const companionLogo = logoFromDescFiles(files);
    const rawChangelog = docFromDescFiles(files, 'changelog.md');
    const companionChangelog =
      rawChangelog !== null ? resolveCompanionAssets(rawChangelog, files) : null;
    const inTree = await this.inTreeDocs(repo, fetchValue, {
      logo: companionLogo === null,
      readme: companionReadme === null,
      changelog: companionChangelog === null,
    });
    return {
      readme: companionReadme ?? inTree.readme,
      logoUri: companionLogo ?? inTree.logoUri,
      changelog: companionChangelog ?? inTree.changelog,
      companionDigest: result.value.digest,
    };
  }

  /** Merges describe/fetch/companion into a VM against a fresh install snapshot. */
  private assembleVM(
    repo: string,
    snapshot: Snapshot,
    describe: DescribeResult | null,
    fetchValue: FetchResult | null,
    docs: CompanionDocs,
  ): DetailsVM {
    const searchItem = this.catalog.state().items.find((i) => i.repo === repo) ?? null;
    const { installs, unknown } = installState(repo, scopeStatuses(snapshot));
    const projectName = snapshot.projectFolder?.split(/[\\/]/).pop() ?? null;
    const vm = buildDetailsVM({
      repo,
      searchItem: searchItem as never,
      describe,
      fetch: fetchValue,
      installs,
      scopes: {
        projectOpen: snapshot.projectFolder !== undefined,
        projectConfigured: projectSearchable(snapshot),
        projectName,
      },
      logoUri: docs.logoUri,
      readme: docs.readme,
      changelog: docs.changelog,
      catalog: this.catalog.state().items as never,
    });
    if (unknown.length > 0) {
      vm.unknownScopes = unknown;
    }
    return vm;
  }

  /** Content pipeline: describe + fetch + companion. The companion comes solely
   *  from `fetch --description`, and only when `describe.has_description === true`
   *  — absent (a binary predating the v2 surface), false, or a null describe means
   *  no companion at all (zero probe spawns), in-tree content only. */
  private async resolveContent(repo: string): Promise<{
    describe: DescribeResult | null;
    fetchValue: FetchResult | null;
    fetchError: string | null;
    companion: CompanionDocs & { companionDigest: string | null };
  }> {
    const [describe, fetch] = await Promise.all([
      this.describe(repo),
      this.scopes.run<FetchResult>(fetchArgs(repo), 'global'),
    ]);
    const fetchValue = fetch.ok ? fetch.value : null;
    const companion =
      describe?.has_description === true
        ? await this.v2Companion(repo, fetchValue)
        : { ...(await this.inTreeDocs(repo, fetchValue)), companionDigest: null };
    const fetchError = !fetch.ok && fetch.kind === 'error' ? fetch.message : null;
    return { describe, fetchValue, fetchError, companion };
  }

  /** True when this probe did NOT resolve everything the artifact is known to
   *  publish. Three ways that happens, all of them a failed sub-fetch rather
   *  than an artifact with nothing to show:
   *
   *  - a doc ADVERTISED in the in-tree file list resolved to null (the `--path`
   *    fetch failed — absence and failure are both null);
   *  - `describe` says there IS a description companion but the companion fetch
   *    failed, so its digest is null. The companion logo is NOT in the artifact's
   *    file list, so the check above cannot see it — this is the case that let a
   *    null logo be cached as a good snapshot;
   *  - `describe` itself failed, so we do not even know what to expect.
   *
   *  Caching an incomplete snapshot under a valid digest would pin the miss to
   *  that digest forever: every later revalidate short-circuits on the matching
   *  digest and never retries. The caller nulls the digest and marks the entry
   *  incomplete instead — content still paints instantly from cache, and the
   *  short retry TTL re-probes it in minutes. */
  private incompleteDocs(
    describe: DescribeResult | null,
    fetchValue: FetchResult,
    companion: CompanionDocs & { companionDigest: string | null },
  ): boolean {
    const missed = (names: string[], value: string | null): boolean =>
      value === null && findAssetPath(fetchValue.files, names) !== null;
    return (
      describe === null ||
      (describe.has_description === true && companion.companionDigest === null) ||
      missed(LOGO_NAMES, companion.logoUri) ||
      missed(['readme.md'], companion.readme) ||
      missed(['changelog.md'], companion.changelog)
    );
  }

  private entryFrom(
    repo: string,
    describe: DescribeResult | null,
    fetchValue: FetchResult | null,
    companion: CompanionDocs & { companionDigest: string | null },
  ): DetailsCacheEntry | null {
    if (!fetchValue) {
      return null;
    }
    const digest = fetchValue.digest ?? null;
    // `complete` and `artifactDigest` say the same thing twice — this probe
    // resolved everything and may be trusted — so they are derived from one
    // expression. A digest-less fetch counts as incomplete for the same reason a
    // missed doc does: there is nothing to short-circuit a later revalidate on.
    const complete = !this.incompleteDocs(describe, fetchValue, companion) && digest !== null;
    return {
      version: CACHE_VERSION,
      repo,
      artifactDigest: complete ? digest : null,
      companionDigest: companion.companionDigest,
      savedAt: new Date().toISOString(),
      describe,
      fetch: fetchValue,
      readme: companion.readme,
      logoUri: companion.logoUri,
      changelog: companion.changelog,
      complete,
    };
  }

  /** The full open pipeline. Returns the VM and the cache entry to persist (null
   *  when the fetch failed). Takes the snapshot so an open resolves it once. */
  private async buildPipeline(
    repo: string,
    snapshot: Snapshot,
  ): Promise<{ vm: DetailsVM; entry: DetailsCacheEntry | null }> {
    const { describe, fetchValue, fetchError, companion } = await this.resolveContent(repo);
    const vm = this.assembleVM(repo, snapshot, describe, fetchValue, companion);
    if (fetchError !== null) {
      vm.error = fetchError;
    }
    return { vm, entry: this.entryFrom(repo, describe, fetchValue, companion) };
  }

  /** Background prefetch: content pipeline → cache save, no snapshot/VM/webview.
   *  Landed logos reach the sidebar through the {@link saveEntry} choke point.
   *  Never touches the revalidate indicator.
   *
   *  A repo the TTL sweep re-queued ({@link isFresh}) is usually unchanged, so it
   *  short-circuits on the describe digest exactly like the on-open revalidate:
   *  re-checking a browse list costs one manifest probe per repo, not a full
   *  blob download. */
  async prefetchInto(repo: string): Promise<void> {
    const cached = await this.cache.load(repo).catch(() => null);
    if (cached) {
      const live = await this.describe(repo);
      if (live && (await this.contentUnchanged(repo, cached, live))) {
        // Unchanged: keep the content, refresh the metadata and the TTL stamp.
        // Complete by construction — contentUnchanged matched BOTH digests, so
        // every doc this artifact publishes is accounted for. Stating it also
        // promotes a pre-`complete` entry off the short retry window.
        await this.saveEntry(repo, {
          ...cached,
          describe: live,
          savedAt: new Date().toISOString(),
          complete: true,
        });
        return;
      }
    }
    const { describe, fetchValue, companion } = await this.resolveContent(repo);
    const entry = this.entryFrom(repo, describe, fetchValue, companion);
    if (entry) {
      await this.saveEntry(repo, entry);
    } else {
      // Nothing was written, so there is no entry to age — without a cooldown
      // this repo comes back on the very next viewport report. This is the
      // sweep path, the one that repeats.
      this.noteProbeFailure(repo);
    }
  }

  /** Cached logo + latest-version decorations for the given repos (misses
   *  omitted) — browse-card enrichment. Goes through this.cache so the test seam
   *  (setCacheDir) covers it. */
  cachedCardMeta(repos: string[]): Promise<Map<string, CachedCardMeta>> {
    return this.cache.presentCardMeta(repos);
  }

  /** Ages a repo's cached snapshot out — the post-action hook, so the refresh
   *  that follows an install/update/version switch re-resolves that artifact
   *  instead of trusting an entry up to six hours old.
   *
   *  Expires, does NOT delete. Deleting was the original shape and it reopened
   *  the vanished-logo bug from the far side: with no entry left, {@link
   *  mergeEntry} has nothing to fold, so a post-action probe that partly failed
   *  painted its nulls over content the user was already looking at. Only the
   *  timestamp is discarded — every probe treats the entry as stale and
   *  re-resolves, and whatever comes back merges over content that is still
   *  there. Failures are swallowed: an entry that would not rewrite is a stale
   *  paint, not a broken action. */
  async expire(repo: string): Promise<void> {
    // Also clears any probe cooldown: this runs because the user acted on the
    // artifact, and a cooldown must never mute the refresh that follows. Clears
    // it as of now, not for the future — a probe already in flight here can land
    // its failure afterwards and re-arm the cooldown, costing the sweep one
    // retry window. Left alone deliberately: reaching it needs the registry to
    // be failing outright, which is when a cooldown is the correct answer.
    this.failedProbes.delete(repo);
    await this.withRepoLock(repo, async () => {
      const cached = await this.cache.load(repo).catch(() => null);
      if (!cached) {
        return;
      }
      // Epoch, not "now minus the TTL": the TTL that applies depends on the
      // entry's own `complete` flag, and a fixed floor is stale under both.
      await this.cache
        .save(repo, { ...cached, savedAt: new Date(0).toISOString() })
        .catch((e) =>
          this.output.appendLine(`details cache expire failed for ${repo}: ${String(e)}`),
        );
    });
  }

  /** The prefetch skip filter — "do not probe this repo right now", for either
   *  of the two reasons that can be true.
   *
   *  Reason one, freshness: an entry still inside its TTL. "Has an entry" alone
   *  made a stale snapshot immortal, so an artifact that published a logo after
   *  its first prefetch kept a codicon tile until the entry was evicted. The
   *  window depends on how the last probe went — a complete snapshot is trusted
   *  for {@link PREFETCH_TTL_MS}, one that missed a doc only for
   *  {@link RETRY_TTL_MS}. An entry predating the flag has no `complete` and
   *  takes the short window: it re-probes once, then settles. An unparsable
   *  savedAt reads as stale, and so does a future-dated one, which used to read
   *  fresh until the clock caught up.
   *
   *  Reason two, cooldown: the last probe failed outright, so nothing was
   *  written and there is no entry to age. Without this a repo the registry is
   *  refusing gets re-queued by EVERY viewport report — and under a 429 those
   *  retries are what keep the 429 coming. Checked before the disk read, so a
   *  cooling repo costs no I/O at all.
   *
   *  Only the background sweep consults this (Prefetcher.enqueue is the sole
   *  caller). Opening a panel is never subject to the COOLDOWN half — muting
   *  something the user just asked for because the registry refused it earlier
   *  would be a bug, not a saving. It does honour a much shorter freshness
   *  window of its own ({@link justProbed} / {@link OPEN_REVALIDATE_TTL_MS}),
   *  which is a different question: not "is this worth sweeping" but "did the
   *  sweep already answer this a moment ago". An explicit refresh passes
   *  `force`, which skips this call entirely.
   *
   *  It does NOT close a registry-wide 429: this is per repo, and 100 different
   *  repos scrolling into view still each fire one probe. That needs a
   *  per-origin breaker, which is deliberately not in this change. */
  async isFresh(repo: string): Promise<boolean> {
    const failedAt = this.failedProbes.get(repo);
    if (failedAt !== undefined) {
      if (Date.now() - failedAt < RETRY_TTL_MS) {
        return true;
      }
      // Expired. Drop it here rather than sweeping: a repo nobody looks at
      // again would otherwise hold its key for the life of the window.
      this.failedProbes.delete(repo);
    }
    const entry = await this.cache.load(repo);
    if (entry === null) {
      return false;
    }
    const age = Date.now() - Date.parse(entry.savedAt);
    const ttl = entry.complete === true ? PREFETCH_TTL_MS : RETRY_TTL_MS;
    return age >= 0 && age < ttl;
  }

  /** Records that a probe produced no entry at all, starting the cooldown above.
   *  Written by every caller that observes a null from {@link entryFrom}; cleared
   *  by {@link saveEntry} and {@link forget}. In memory only — a cooldown is a
   *  hint about the last few minutes, not state worth surviving a reload. */
  private noteProbeFailure(repo: string): void {
    this.failedProbes.set(repo, Date.now());
  }

  /** Full-pipeline VM, persisting the snapshot for a future instant paint. Used
   *  by postVM (actions/refresh) and directly by the tests. `check` threads to
   *  `grim status --check` so an explicit "Check for updates" refresh gives open
   *  panels network-verified update/deprecation data, matching the sidebar. */
  async buildVM(repo: string, options: { check?: boolean } = {}): Promise<DetailsVM> {
    // Hoisted: vmFromCache needs the same snapshot buildPipeline resolves.
    const snapshot = await this.scopes.snapshot(options);
    const { vm, entry } = await this.buildPipeline(repo, snapshot);
    if (!entry) {
      // The fetch itself failed. This vm is the only one carrying vm.error, and
      // there is nothing merged to paint instead.
      this.noteProbeFailure(repo);
      return vm;
    }
    // Paint what was stored, not what was probed: a partly-failed probe carries
    // nulls that the merge just filled back in from cache.
    return this.vmFromCache(repo, await this.saveEntry(repo, entry), snapshot);
  }

  /** The single save choke point — so the merge below covers every writer,
   *  present and future. A probe that partly failed carries nulls for the parts
   *  it could not resolve; {@link mergeEntry} keeps the cached content under
   *  them, and the sidebar repost fires off the MERGED entry, so a good logo is
   *  never withdrawn from a browse card by a failed re-probe.
   *
   *  Returns the merged entry, because the merge is also what the caller should
   *  PAINT. Writing one thing and posting another is how the vanished-logo bug
   *  survived its own fix: the cache kept the logo and the panel repainted the
   *  null the probe had just failed to resolve.
   *
   *  Serialized per repo ({@link withRepoLock}), because load → merge → save is
   *  a read-modify-write with two awaits inside it. Opening a panel while the
   *  background sweep is probing the SAME repo is the ordinary case, not a rare
   *  one — the viewport reports the row the user just clicked — and unserialized
   *  the later save merges against a snapshot taken before the earlier one
   *  landed, dropping exactly the content the merge exists to preserve.
   *
   *  The lock covers this path and {@link expire}, not every writer: the two
   *  metadata-only saves (the unchanged-digest branch of {@link prefetchInto},
   *  and revalidate) read `cached` outside it and hand back a `complete: true`
   *  entry, which mergeEntry takes wholesale. Those rest on C-004 — incomplete
   *  implies a null artifactDigest, so `contentUnchanged` cannot match against
   *  an incomplete entry and they only ever run over content already proven
   *  current. Relaxing C-004 reopens this class; the lock would not catch it. */
  private async saveEntry(repo: string, entry: DetailsCacheEntry): Promise<DetailsCacheEntry> {
    return this.withRepoLock(repo, () => this.saveEntryInner(repo, entry));
  }

  /** Runs `fn` with no other locked write in flight for the same repo. Different
   *  repos never wait on each other.
   *
   *  ponytail: per-process, and unbounded. Two VS Code windows sharing
   *  globalStorage still race each other — DetailsCache.save already writes via
   *  a tmp file for that reason — and a `fn` that never settles wedges its repo
   *  for the session. Per-window is the ceiling; a cross-process lock or a
   *  timeout is the upgrade path, and neither is worth it for a content cache
   *  whose worst case is one re-probe. */
  private async withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.saveQueue.get(repo);
    let release!: () => void;
    // Resolve-only by construction, so awaiting it needs no rejection handler:
    // `finally` below is what guarantees a thrown predecessor still releases.
    const tail = new Promise<void>((resolve) => (release = resolve));
    this.saveQueue.set(repo, tail);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this.saveQueue.get(repo) === tail) {
        this.saveQueue.delete(repo);
      }
    }
  }

  private async saveEntryInner(repo: string, entry: DetailsCacheEntry): Promise<DetailsCacheEntry> {
    const merged = mergeEntry(await this.cache.load(repo).catch(() => null), entry);
    await this.cache
      .save(repo, merged)
      .catch((e) => this.output.appendLine(`details cache save failed for ${repo}: ${String(e)}`));
    // The repo answered, whatever else failed — so it is not in a cooldown.
    this.failedProbes.delete(repo);
    if (cardMetaOf(merged)) {
      this.onCardMetaCached();
    }
    // Returned even when the write threw: the merge is still the best truth we
    // hold, and painting it beats painting the raw probe.
    return merged;
  }

  /** Builds a VM from cached content + a given install/scope snapshot (sync — the
   *  caller decides stale-for-instant-paint vs fresh). */
  private vmFromCache(repo: string, cached: DetailsCacheEntry, snapshot: Snapshot): DetailsVM {
    return this.assembleVM(repo, snapshot, cached.describe, cached.fetch, {
      logoUri: cached.logoUri,
      readme: cached.readme,
      changelog: cached.changelog,
    });
  }

  /** The install/scope slice of a VM — compared to decide whether a snapshot
   *  refresh actually changed the install rows (else no repost, no flicker).
   *  Stringifies BOTH `installs` and `unknown`: a scope that flips empty→unknown
   *  keeps `installs` at `[]`, so without `unknown` in the slice the two compare
   *  equal and the warm repost leaks a stale "Not installed" (Codex#1). Public
   *  for the slice-difference regression test. */
  installSlice(repo: string, snapshot: Snapshot): string {
    const { installs, unknown } = installState(repo, scopeStatuses(snapshot));
    return JSON.stringify({
      installs,
      unknown,
      projectOpen: snapshot.projectFolder !== undefined,
      projectConfigured: projectSearchable(snapshot),
      projectName: snapshot.projectFolder?.split(/[\\/]/).pop() ?? null,
    });
  }


  /** The SWR short-circuit, shared by the on-open revalidate and the prefetch
   *  re-probe: a live describe proves the cached content current when BOTH the
   *  artifact manifest digest and the companion digest still match. A describe
   *  without has_description simply means "no companion" (null digest), so a
   *  live describe always drives — no legacy branch. A cached entry with a null
   *  artifactDigest (see {@link incompleteDocs}) can never match, so a snapshot
   *  whose doc fetch failed always re-runs the pipeline. */
  private async contentUnchanged(
    repo: string,
    cached: DetailsCacheEntry,
    live: DescribeResult,
  ): Promise<boolean> {
    if (cached.artifactDigest === null || live.digest !== cached.artifactDigest) {
      return false;
    }
    if (live.has_description !== true) {
      // No companion to compare. A cached digest here means the artifact HAD one
      // and the publisher removed it — content changed.
      return cached.companionDigest === null;
    }
    const probe = await this.scopes.run<DigestResult>(
      fetchArgs(repo, { description: true, digestOnly: true }),
      'global',
    );
    if (!probe.ok) {
      // A probe that could not run proves nothing. This used to collapse into
      // the same null the "no companion" branch produces, so a failed probe
      // against an entry with no cached companion digest compared null to null
      // and declared the content current — then stamped it complete on the six
      // hour window, hiding a newly published logo for exactly as long.
      return false;
    }
    return probe.value.digest === cached.companionDigest;
  }

  /** Last concrete revalidate-failure message per repo, so the indicator click
   *  handler shows it without trusting webview-supplied text. */
  private lastFailure = new Map<string, string>();

  /** repo → when its last probe failed outright. Drives the cooldown half of
   *  {@link isFresh}; see {@link noteProbeFailure}. */
  private readonly failedProbes = new Map<string, number>();

  /** repo → the tail of its in-flight {@link withRepoLock} chain. Entries are
   *  dropped as soon as the chain drains, so this holds only active repos. */
  private readonly saveQueue = new Map<string, Promise<void>>();

  /** Posts the background-revalidate status for the top-right indicator. Only
   *  used on warm reopens (a cached paint is on screen). */
  private postRevalidate(
    panel: vscode.WebviewPanel,
    state: RevalidateState,
    message?: string,
  ): void {
    if (this.disposedPanels.has(panel)) {
      return;
    }
    void panel.webview.postMessage({
      type: 'revalidate',
      state,
      ...(message !== undefined ? { message } : {}),
    } satisfies HostToDetails);
  }

  /** Stale-while-revalidate open. Warm + a last-known snapshot: paint cached
   *  content against that STALE snapshot immediately — zero grim spawns before
   *  the first paint (the user's READMEs/logos don't wait on install-row
   *  freshness). Then one fresh snapshot: repost only if the install rows
   *  actually changed, and thread it into revalidate so an open resolves the
   *  snapshot exactly once. */
  private async paint(repo: string, panel: vscode.WebviewPanel): Promise<void> {
    const cached = await this.cache.load(repo).catch(() => null);
    if (!cached) {
      this.postSkeleton(repo, panel);
      await this.revalidate(repo, panel, null);
      return;
    }
    const stale = this.scopes.cachedSnapshot();
    if (!stale) {
      // First open of the session (no snapshot yet): await a fresh one, as before.
      const fresh = await this.scopes.snapshot();
      await this.postBuilt(repo, panel, this.vmFromCache(repo, cached, fresh));
      await this.revalidate(repo, panel, cached, fresh);
      return;
    }
    await this.postBuilt(repo, panel, this.vmFromCache(repo, cached, stale));
    const fresh = await this.scopes.snapshot();
    if (this.installSlice(repo, fresh) !== this.installSlice(repo, stale)) {
      await this.postBuilt(repo, panel, this.vmFromCache(repo, cached, fresh));
    }
    await this.revalidate(repo, panel, cached, fresh);
  }

  /** Revalidates a painted panel. With a v2 grim + a cached entry, a live describe
   *  (manifest digest, no blob download) plus a companion digest-only probe
   *  short-circuits when content is unchanged — reposting only cheap metadata (new
   *  tag, deprecation) without a content fetch. Otherwise the full pipeline runs
   *  and reposts only when the content digests differ (no flicker). */
  private async revalidate(
    repo: string,
    panel: vscode.WebviewPanel,
    cached: DetailsCacheEntry | null,
    /** The fresh snapshot paint already fetched; resolved here (once) when cold. */
    snapshot?: Snapshot,
  ): Promise<void> {
    // ponytail: concurrent revalidations for one repo just last-write-wins — a
    // details panel is cheap to repaint, not worth a per-repo lock.
    // describe is authoritative for both the manifest digest AND the rail metadata,
    // so it catches new tags / deprecation that leave the artifact blob untouched.
    // The top-right indicator is driven only when a cached paint is on screen —
    // cold opens go straight skeleton→full with no background-check UI.
    if (cached) {
      if (justProbed(cached)) {
        // Nothing to check: the sweep proved this entry current a moment ago.
        this.postRevalidate(panel, 'done');
        return;
      }
      this.postRevalidate(panel, 'checking');
    }
    const live = await this.describe(repo);
    if (cached && live) {
      if (await this.contentUnchanged(repo, cached, live)) {
        if (JSON.stringify(live) !== JSON.stringify(cached.describe)) {
          // Metadata-only change: refresh describe, keep the cached content.
          // Complete by construction — contentUnchanged matched the artifact
          // digest AND either proved the companion digest or proved there is no
          // companion, so nothing this artifact publishes is unaccounted for.
          // Stating it also promotes an entry written before the flag existed
          // off the short retry window instead of re-arming it every visit.
          const entry: DetailsCacheEntry = {
            ...cached,
            describe: live,
            savedAt: new Date().toISOString(),
            complete: true,
          };
          const stored = await this.saveEntry(repo, entry);
          const snap = snapshot ?? (await this.scopes.snapshot());
          await this.postBuilt(repo, panel, this.vmFromCache(repo, stored, snap));
        }
        this.postRevalidate(panel, 'done'); // unchanged or metadata-only: both settle to done
        return;
      }
    }
    // Content changed, no cache, or describe failed (offline): full pipeline.
    // ponytail: re-runs describe once here — one extra list_tags, fine.
    const snap = snapshot ?? (await this.scopes.snapshot());
    const { vm, entry } = await this.buildPipeline(repo, snap);
    const stored = entry ? await this.saveEntry(repo, entry) : null;
    if (!entry) {
      this.noteProbeFailure(repo);
    }
    if (!cached) {
      // Cold: vm.error (fetch failed, no content) renders the in-body error block.
      // Also surface it as a notification — deduped, so a watch storm won't spam.
      if (vm.error) {
        notifyError(`Grimoire: ${vm.error}`, { dedupe: true });
      }
      await this.postBuilt(repo, panel, vm);
      return;
    }
    if (!stored) {
      // Revalidate failed with a cached paint on screen: keep it, no in-body error.
      // The fetch error (whichever step surfaced it) rides in vm.error; store it so
      // the indicator click can show the concrete message, and notify (deduped —
      // file-watch storms re-trigger revalidation).
      const message = vm.error ?? 'Refresh failed — showing cached data';
      this.output.appendLine(`details revalidate failed for ${repo}: ${message}`);
      this.lastFailure.set(repo, message);
      notifyError(`Grimoire: ${message}`, { dedupe: true });
      this.postRevalidate(panel, 'failed', message);
      return;
    }
    // Repost when the user would SEE something different — not when a digest
    // moved. Digests are wrong both ways here: an incomplete probe nulls them,
    // so a retry that recovered a logo compared null to null and stayed silent
    // while the cache quietly improved; and a fold that restored identical
    // content still differs by digest, which repainted for nothing.
    if (paintSignature(stored) !== paintSignature(cached)) {
      await this.postBuilt(repo, panel, this.vmFromCache(repo, stored, snap));
    }
    this.postRevalidate(panel, 'done');
  }
}

interface CompanionDocs {
  logoUri: string | null;
  readme: string | null;
  changelog: string | null;
}

/** README/CHANGELOG body from an inline v2 companion report (utf8 members only).
 *  content is omit-empty (an empty member ships none) → null. */
function docFromDescFiles(files: DescFile[], name: string): string | null {
  const docPath = findAssetPath(files, [name]);
  if (!docPath) {
    return null;
  }
  const file = files.find((f) => f.path === docPath);
  if (!file || file.encoding === 'base64') {
    return null;
  }
  return file.content ?? null;
}

/** Logo data: URI from an inline v2 companion report; mirrors {@link fetchLogo}. */
function logoFromDescFiles(files: DescFile[]): string | null {
  const logoPath = findAssetPath(files, LOGO_NAMES);
  if (!logoPath) {
    return null;
  }
  const file = files.find((f) => f.path === logoPath);
  if (!file || file.content === undefined) {
    return null;
  }
  const ext = logoPath.split('.').pop()?.toLowerCase() ?? 'png';
  const mime = LOGO_MIME[ext] ?? 'image/png';
  if (file.encoding === 'base64') {
    return `data:${mime};base64,${file.content}`;
  }
  if (ext === 'svg') {
    return `data:${mime};base64,${Buffer.from(file.content, 'utf8').toString('base64')}`;
  }
  return null;
}

/** The install/unknown split for one repo across scopes, in a single pass so a
 *  caller can never take the `installs` half without the `unknown` half (arch
 *  F5). `installs` reports presence; `unknown` names the scopes whose install
 *  state could not be determined (`status: null`) — WITHOUT it the panel reads
 *  an unknown scope's missing install as "Not installed" and offers an Install
 *  button for an artifact that may already be there (finding A2), and the warm
 *  installSlice compares `[]` (empty) equal to `[]` (unknown) and leaks a stale
 *  repost (Codex#1). Exported for the slice-difference regression test. */
export function installState(
  repo: string,
  scopes: ScopeStatus[],
): { installs: DetailsVM['installs']; unknown: Scope[] } {
  const installs: DetailsVM['installs'] = [];
  const unknown: Scope[] = [];
  for (const scope of scopes) {
    if (scope.status === null) {
      unknown.push(scope.scope); // unknown, not empty — never an install row
      continue;
    }
    for (const item of scope.status) {
      // Keyed by (kind, name) — see declaredKey: one name can be declared in
      // two artifact tables, and by name alone this panel matched the OTHER
      // kind's row and showed it as an install of this repo.
      const declared = scope.declared[declaredKey(item.kind, item.name)];
      // pinned is null for unlocked artifacts — an undeclared, unlocked item
      // has no repo to match against, so it never matches (rather than deref null).
      const matches = declared
        ? refRepo(declared) === repo
        : item.pinned !== null && refRepo(item.pinned) === repo;
      if (matches) {
        installs.push({
          scope: scope.scope,
          version: declared ? refTag(declared) : null,
          updateAvailable: computeUpdateAvailable(item),
          clients: item.outputs.map((o) => o.client),
          state: item.state,
          kind: item.kind,
          name: item.name,
          viaBundles: parseViaBundles(item.source),
          floating: item.pinned === null,
          outputsPending: item.outputs_pending ?? [],
        });
      }
    }
  }
  return { installs, unknown };
}
