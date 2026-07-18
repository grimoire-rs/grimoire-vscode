// Details editor tabs: one WebviewPanel per repo, revealed on reopen. State
// is rebuilt from grim on every open (and on refreshAll), so panels are not
// retained when hidden. A minimal serializer restores panels across reloads.
import * as vscode from 'vscode';
import {
  addArgs,
  describeArgs,
  fetchArgs,
  initArgs,
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
import { CACHE_VERSION, DetailsCache, type DetailsCacheEntry } from '../detailsCache';
import type { CatalogService } from '../catalog';
import { projectSearchable, type ScopeService, type Snapshot } from '../scopes';
import {
  artifactName,
  buildDetailsVM,
  buildShareLink,
  buildSkeletonVM,
  computeUpdateAvailable,
  findAssetPath,
  normalizeKind,
  parseViaBundles,
  refRepo,
  refTag,
  resolveCompanionAssets,
  type ScopeStatus,
} from '../webview/model';
import type {
  DetailsToHost,
  DetailsVM,
  HostToDetails,
  RevalidateState,
  ScopesVM,
} from '../webview/protocol';
import { notifyError, runWithStatusProgress } from '../notify';
import { esc, renderDetails } from '../webview/render';
import { render } from '@lit-labs/ssr';
import { collectResultSync } from '@lit-labs/ssr/lib/render-result.js';
import { webviewHtml } from './html';
import { scopeStatuses } from './sidebar';
import { pickVersion } from './pickVersion';
import { offerFullUpdate } from './staleLock';

export const DETAILS_VIEW_TYPE = 'grimoire.details';

const LOGO_NAMES = ['logo.png', 'logo.svg', 'icon.png'];
const LOGO_MIME: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
};

const KIND_LABELS: Record<string, string> = {
  skill: 'Skill',
  rule: 'Rule',
  agent: 'Agent',
  mcp: 'MCP',
  bundle: 'Bundle',
};

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
  ) {
    this.cache = new DetailsCache(cacheDir);
  }

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
    this.attach(repo, panel);
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
    this.attach(repo, panel);
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
    this.attach(repo, panel);
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

  private renderHtml(webview: vscode.Webview, repo: string): string {
    // Inline the skeleton server-side so the first HTML parse shows the full
    // structure before the script boots — no empty shell awaiting the ready
    // round-trip. main.ts's first message-driven render replaces #root wholesale.
    // renderDetails returns a lit TemplateResult now; @lit-labs/ssr renders it to
    // the same markup string the webview's first lit render produces (the host
    // bundle is platform:node, so lit-html's Node/SSR export conditions resolve).
    // collectResultSync keeps attach synchronous — the skeleton template has no
    // async directives, and the sync path preserves the pre-lit timing that
    // panel.webview.html is populated before attach's caller returns.
    return webviewHtml(
      webview,
      this.extensionUri,
      'details',
      `data-repo="${esc(repo)}"`,
      collectResultSync(render(renderDetails(this.skeletonVM(repo)))),
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

  private attach(repo: string, panel: vscode.WebviewPanel): void {
    // Register listeners before the html assignment so a 'ready' — only
    // reachable once html boots the webview — is never missed. html is assigned
    // exactly ONCE per panel (reassigning html reboots the webview — a tested
    // invariant).
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
    panel.webview.html = this.renderHtml(panel.webview, repo);
  }

  /** Re-sends fresh view models to every open panel (after installs etc.),
   *  including the reusable preview slot. postVM re-checks the panel's repo, so
   *  a preview retargeted mid-refresh discards the stale VM. */
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
    const installs =
      cached && (cached.project || cached.global)
        ? installsFor(repo, scopeStatuses(cached))
        : undefined;
    return buildSkeletonVM(repo, searchItem as never, scopes, installs);
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
    vm.isPreview = this.preview?.panel === panel;
    void panel.webview.postMessage({ type: 'artifact', vm } satisfies HostToDetails);
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
  private async postBuilt(
    repo: string,
    panel: vscode.WebviewPanel,
    vm: DetailsVM,
  ): Promise<void> {
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

  /** Public for tests: the webview message entry point. */
  async onMessage(repo: string, panel: vscode.WebviewPanel, message: DetailsToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.paint(repo, panel);
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
      case 'openExternal':
        if (/^https?:/.test(message.url)) {
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
    }
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
    await this.suspendWhile(() =>
      this.actionInner(repo, panel, steps, scope, busy, staleLockName),
    );
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
          const message =
            result.kind === 'not-found' ? 'grim executable not found' : result.message;
          this.output.appendLine(`error: ${message}`);
          // Name the failing step — an init→add sequence can fail halfway.
          notifyError(`Grimoire: grim ${args[0]}: ${message}`);
          // An earlier step may have changed state (init created grimoire.toml),
          // so refresh the views even on failure, then clear the busy state.
          if (last !== undefined) {
            await this.onDidChange();
          }
          await this.postVM(repo, panel);
          return;
        }
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
      want.changelog ? this.fetchDoc(repo, fetchValue.files, 'changelog.md') : Promise.resolve(null),
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
    const installs = installsFor(repo, scopeStatuses(snapshot));
    const projectName = snapshot.projectFolder?.split(/[\\/]/).pop() ?? null;
    return buildDetailsVM({
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

  private entryFrom(
    repo: string,
    describe: DescribeResult | null,
    fetchValue: FetchResult | null,
    companion: CompanionDocs & { companionDigest: string | null },
  ): DetailsCacheEntry | null {
    return fetchValue
      ? {
          version: CACHE_VERSION,
          repo,
          artifactDigest: fetchValue.digest ?? null,
          companionDigest: companion.companionDigest,
          savedAt: new Date().toISOString(),
          describe,
          fetch: fetchValue,
          readme: companion.readme,
          logoUri: companion.logoUri,
          changelog: companion.changelog,
        }
      : null;
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
   *  Returns whether a logo landed so the caller can pop it into the browse
   *  cards. Never touches the revalidate indicator. */
  async prefetchInto(repo: string): Promise<{ hadLogo: boolean }> {
    const { describe, fetchValue, companion } = await this.resolveContent(repo);
    const entry = this.entryFrom(repo, describe, fetchValue, companion);
    if (entry) {
      await this.saveEntry(repo, entry);
    }
    return { hadLogo: !!entry?.logoUri };
  }

  /** Cached logo data-URIs for the given repos (misses omitted) — browse-card
   *  enrichment. Goes through this.cache so the test seam (setCacheDir) covers it. */
  cachedLogos(repos: string[]): Promise<Map<string, string>> {
    return this.cache.presentLogos(repos);
  }

  /** True when the repo already has a cache entry — the prefetch skip filter
   *  (freshness stays the on-open revalidate's job, so no digest probe here). */
  async hasCached(repo: string): Promise<boolean> {
    return (await this.cache.load(repo)) !== null;
  }

  /** Full-pipeline VM, persisting the snapshot for a future instant paint. Used
   *  by postVM (actions/refresh) and directly by the tests. `check` threads to
   *  `grim status --check` so an explicit "Check for updates" refresh gives open
   *  panels network-verified update/deprecation data, matching the sidebar. */
  async buildVM(repo: string, options: { check?: boolean } = {}): Promise<DetailsVM> {
    const { vm, entry } = await this.buildPipeline(repo, await this.scopes.snapshot(options));
    if (entry) {
      await this.saveEntry(repo, entry);
    }
    return vm;
  }

  private async saveEntry(repo: string, entry: DetailsCacheEntry): Promise<void> {
    await this.cache
      .save(repo, entry)
      .catch((e) => this.output.appendLine(`details cache save failed for ${repo}: ${String(e)}`));
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
   *  refresh actually changed the install rows (else no repost, no flicker). */
  private installSlice(repo: string, snapshot: Snapshot): string {
    return JSON.stringify({
      installs: installsFor(repo, scopeStatuses(snapshot)),
      projectOpen: snapshot.projectFolder !== undefined,
      projectConfigured: projectSearchable(snapshot),
      projectName: snapshot.projectFolder?.split(/[\\/]/).pop() ?? null,
    });
  }

  private async digestOnly(args: string[]): Promise<string | null> {
    const result = await this.scopes.run<DigestResult>(args, 'global');
    return result.ok ? result.value.digest : null;
  }

  /** Last concrete revalidate-failure message per repo, so the indicator click
   *  handler shows it without trusting webview-supplied text. */
  private lastFailure = new Map<string, string>();

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
      this.postRevalidate(panel, 'checking');
    }
    const live = await this.describe(repo);
    if (cached && live) {
      // A describe without has_description simply means "no companion" (null
      // digest), so a live describe always drives — no legacy branch.
      const companionDigest =
        live.has_description === true
          ? await this.digestOnly(fetchArgs(repo, { description: true, digestOnly: true }))
          : null;
      const contentSame =
        live.digest === cached.artifactDigest && companionDigest === cached.companionDigest;
      if (contentSame) {
        if (JSON.stringify(live) !== JSON.stringify(cached.describe)) {
          // Metadata-only change: refresh describe, keep the cached content.
          const entry: DetailsCacheEntry = {
            ...cached,
            describe: live,
            savedAt: new Date().toISOString(),
          };
          await this.saveEntry(repo, entry);
          const snap = snapshot ?? (await this.scopes.snapshot());
          await this.postBuilt(repo, panel, this.vmFromCache(repo, entry, snap));
        }
        this.postRevalidate(panel, 'done'); // unchanged or metadata-only: both settle to done
        return;
      }
    }
    // Content changed, no cache, or describe failed (offline): full pipeline.
    // ponytail: re-runs describe once here — one extra list_tags, fine.
    const { vm, entry } = await this.buildPipeline(repo, snapshot ?? (await this.scopes.snapshot()));
    if (entry) {
      await this.saveEntry(repo, entry);
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
    if (!entry) {
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
    const changed =
      entry.artifactDigest !== cached.artifactDigest ||
      entry.companionDigest !== cached.companionDigest;
    if (changed) {
      await this.postBuilt(repo, panel, vm);
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

function installsFor(repo: string, scopes: ScopeStatus[]): DetailsVM['installs'] {
  const installs: DetailsVM['installs'] = [];
  for (const scope of scopes) {
    for (const item of scope.status) {
      const declared = scope.declared[item.name];
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
        });
      }
    }
  }
  return installs;
}
