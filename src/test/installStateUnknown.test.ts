// Specification tests for Phase 1 of plan_review-findings: an unknown install
// state (`ScopeSnapshot.status === null`) must never degrade into the positive
// claim "nothing is installed". These drive the real hosts — SidebarProvider
// and DetailsManager — with doubles for grim, and assert on what the user ends
// up looking at (the rendered sidebar / the panel's first-paint HTML) rather
// than on any particular field the hosts choose to carry the fact in.
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CatalogService, CatalogState } from '../catalog';
import type { ContextInfo, GrimResult, SearchItem, StatusItem } from '../grim';
import type { ScopeService, ScopeSnapshot, Snapshot } from '../scopes';
import { DetailsManager } from '../views/details';
import { SidebarProvider, type SidebarDelegate } from '../views/sidebar';
import { DEFAULT_FILTER } from '../webview/model';
import type { GrimOrigin, HostToSidebar, SidebarState } from '../webview/protocol';
import { renderDetails, renderSidebar } from '../webview/render';
import { litString } from './litString';
import { normalizeHtml } from './normalizeHtml';

const REPO = 'ghcr.io/grimoire-rs/skills/grim-usage';

/** Renders a posted sidebar state exactly as the webview would, so every
 *  assertion below is about what the user sees. */
async function renderState(state: SidebarState): Promise<string> {
  return normalizeHtml(await litString(renderSidebar(state, DEFAULT_FILTER)));
}

function contextInfo(overrides: Partial<ContextInfo> = {}): ContextInfo {
  return {
    version: '0.11.0',
    scope: 'global',
    workspace: null,
    config_path: '/home/u/.grimoire/grimoire.toml',
    config_exists: true,
    lock_path: '/home/u/.grimoire/grimoire.lock',
    lock_exists: true,
    grim_home: '/home/u/.grimoire',
    offline: false,
    clients: [],
    registries: [],
    default_registry: 'ghcr.io/grimoire-rs',
    ...overrides,
  };
}

function statusItem(): StatusItem {
  return {
    kind: 'skill',
    name: 'grim-usage',
    source: 'direct',
    pinned: `${REPO}@sha256:abc`,
    state: 'installed',
    outputs: [{ client: 'claude', path: '/x' }],
    clients_missing: [],
    clients_extra: [],
    deprecated: null,
    replaced_by: null,
    update_available: null,
  };
}

/** A global scope that knows what is installed in it. */
function knownScope(): ScopeSnapshot {
  return {
    context: contextInfo(),
    status: [statusItem()],
    declared: { 'grim-usage': `${REPO}:1.5.0` },
  };
}

/** A global scope whose install state could not be determined. */
function unknownScope(reason: 'too-old' | 'status-failed'): ScopeSnapshot {
  return {
    context: contextInfo(),
    status: null,
    statusUnknownReason: reason,
    declared: { 'grim-usage': `${REPO}:1.5.0` },
  };
}

function healthySnapshot(): Snapshot {
  return { grimMissing: false, global: knownScope() };
}

function degradedSnapshot(
  reason: 'too-old' | 'status-failed',
  message = 'grim 0.9.1 at /usr/bin/grim is too old.',
): Snapshot {
  return { grimMissing: false, global: unknownScope(reason), error: message };
}

function searchItem(): SearchItem {
  return {
    kind: 'skill',
    repo: REPO,
    summary: null,
    description: 'Drive the grim CLI.',
    version: '1.5.0',
    latest_tag: null,
    repository: null,
    revision: null,
    created: null,
    deprecated: null,
    status: 'not-installed',
  };
}

/** Minimal WebviewView double: SidebarProvider only needs somewhere to post
 *  messages, an html sink, and a settable badge. */
function fakeView(posted: HostToSidebar[]): vscode.WebviewView {
  const noopEvent = (): vscode.Disposable => ({ dispose: () => {} });
  const view = {
    viewType: 'grimoire.sidebar',
    visible: true,
    show: () => {},
    onDidDispose: noopEvent,
    onDidChangeVisibility: noopEvent,
    badge: undefined as vscode.ViewBadge | undefined,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage: noopEvent,
      postMessage: (message: HostToSidebar) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
  };
  return view as unknown as vscode.WebviewView;
}

/** Every sidebar state posted so far, in order. */
function statesOf(posted: HostToSidebar[]): SidebarState[] {
  return posted.flatMap((m) => (m.type === 'state' ? [m.state] : []));
}

function lastState(posted: HostToSidebar[]): SidebarState {
  const states = statesOf(posted);
  const last = states[states.length - 1];
  assert.ok(last, 'expected at least one posted state');
  return last;
}

/** A SidebarProvider wired to a queue of snapshots (the last one repeats once
 *  the queue drains) and a catalog that always succeeds. `origin` is what the
 *  resolved-executable probe reports — it gates which remedy the banner offers
 *  (A4). */
function makeSidebar(
  snapshots: Snapshot[],
  origin: GrimOrigin = 'bundled',
): {
  provider: SidebarProvider;
  posted: HostToSidebar[];
  view: vscode.WebviewView;
} {
  const queue = [...snapshots];
  let last = queue[0] ?? healthySnapshot();
  const scopes = {
    snapshot: async (): Promise<Snapshot> => {
      last = queue.shift() ?? last;
      return last;
    },
    resolvedExecutable: (): { path: string; origin: GrimOrigin } => ({ path: 'grim', origin }),
  } as unknown as ScopeService;
  const catalog = {
    search: async (): Promise<CatalogState> => ({ items: [searchItem()], syncedAt: Date.now() }),
  } as unknown as CatalogService;
  const delegate: SidebarDelegate = {
    openDetails: () => {},
    installGrim: async () => {},
    refreshAll: async () => {},
    pin: async () => {},
    pickVersion: async () => {},
    suspendWhile: (fn) => fn(),
    cachedLogos: async () => new Map<string, string>(),
    prefetch: () => {},
  };
  const posted: HostToSidebar[] = [];
  const output = vscode.window.createOutputChannel('grimoire-test');
  const provider = new SidebarProvider(
    vscode.Uri.file(os.tmpdir()),
    scopes,
    catalog,
    delegate,
    output,
  );
  const view = fakeView(posted);
  provider.resolveWebviewView(view);
  return { provider, posted, view };
}

suite('unknown install state: sidebar', () => {
  test('a logo repost after a failed status keeps the banner and the affordance suppression (A1)', async () => {
    // A good refresh fills lastReady, then status fails; the prefetcher's logo
    // repost runs off lastReady and must not repaint the view as a clean,
    // fully-trusted "ready" state.
    const { provider, posted } = makeSidebar([
      healthySnapshot(),
      degradedSnapshot('status-failed'),
    ]);
    await provider.refresh();
    await provider.refresh();
    const degraded = await renderState(lastState(posted));
    assert.ok(degraded.includes('Install state is unavailable'), 'precondition: banner is up');

    await provider.repostLogos();
    const afterRepost = await renderState(lastState(posted));
    assert.ok(
      afterRepost.includes('Install state is unavailable'),
      'the banner survives a logo repost',
    );
    assert.ok(
      !afterRepost.includes('data-action="install"'),
      'no Install button reappears on a card we can no longer vouch for',
    );
    assert.ok(
      !afterRepost.includes('data-action="update"'),
      'no Update button reappears either',
    );
    // The discriminating check (rev-tests#3): lastReady's card is `installed`,
    // which renders a manage gear (data-action="menu"), NOT Install/Update — so
    // the two assertions above pass even with the repost's installStateUnknown
    // stamping reverted. The suppressed gear is what actually proves the repost
    // carried the trust verdict.
    assert.ok(
      !afterRepost.includes('data-action="menu"'),
      'the manage gear stays suppressed too — the repost carried installStateUnknown',
    );
  });

  test('the loading repost of a watcher refresh keeps the banner up (D2)', async () => {
    // Refresh 1 discovers the failure; refresh 2's very first post is the
    // loading state, which must still carry it (otherwise the banner blinks out
    // and back on every watcher round).
    const { provider, posted } = makeSidebar([
      degradedSnapshot('status-failed'),
      degradedSnapshot('status-failed'),
      healthySnapshot(),
    ]);
    await provider.refresh();
    const beforeSecond = statesOf(posted).length;

    await provider.refresh();
    const loading = statesOf(posted)[beforeSecond];
    assert.ok(loading, 'the second refresh posted');
    assert.strictEqual(loading.phase, 'loading', 'a refresh opens with a loading post');
    assert.ok(
      (await renderState(loading)).includes('Install state is unavailable'),
      'the banner does not blink out while the next refresh is in flight',
    );

    // ...and it does clear once status works again — the banner is last-known,
    // not sticky.
    const beforeThird = statesOf(posted).length;
    await provider.refresh();
    const recovered = await renderState(lastState(posted));
    assert.ok(statesOf(posted).length > beforeThird, 'the recovery refresh posted');
    assert.ok(
      !recovered.includes('Install state is unavailable'),
      'a working status clears the banner',
    );
  });

  test('the banner offers "Install grim" only for a too-old binary the extension can replace (A4)', async () => {
    // too-old + an extension-managed ('bundled') binary: installing a current
    // one actually swaps what gets spawned, so the remedy is Install grim.
    const bundled = makeSidebar([degradedSnapshot('too-old')], 'bundled');
    await bundled.provider.refresh();
    const bundledHtml = await renderState(lastState(bundled.posted));
    assert.ok(bundledHtml.includes('Install state is unavailable'), 'banner is up');
    assert.ok(
      bundledHtml.includes('data-action="install-grim"'),
      'a too-old bundled binary is fixed by installing a current one',
    );
    assert.ok(!bundledHtml.includes('data-action="show-grim-info"'), 'Install grim, not diagnostics');

    // too-old but the resolved binary is on PATH: resolveExecutable keeps
    // preferring the PATH copy, so a download changes nothing — offer diagnostics
    // (Show grim Info), never the no-op Install grim loop.
    const onPath = makeSidebar([degradedSnapshot('too-old')], 'PATH');
    await onPath.provider.refresh();
    const onPathHtml = await renderState(lastState(onPath.posted));
    assert.ok(
      !onPathHtml.includes('data-action="install-grim"'),
      'installing a bundled grim cannot shadow a too-old PATH grim',
    );
    assert.ok(
      onPathHtml.includes('data-action="show-grim-info"'),
      'a PATH grim gets the diagnostics remedy instead',
    );

    // A working binary whose status call failed is not fixable by installing
    // either — same diagnostics remedy, never Install grim.
    const failed = makeSidebar(
      [degradedSnapshot('status-failed', 'grim status failed: permission denied.')],
      'bundled',
    );
    await failed.provider.refresh();
    const failedHtml = await renderState(lastState(failed.posted));
    assert.ok(
      failedHtml.includes('grim status failed: permission denied.'),
      'the reason is still shown',
    );
    assert.ok(
      !failedHtml.includes('data-action="install-grim"'),
      'installing a second grim cannot fix a working grim whose status call failed',
    );
    assert.ok(
      failedHtml.includes('data-action="show-grim-info"'),
      'a non-too-old failure still offers diagnostics',
    );
  });

  test('a project-probe failure freezes the badge — it never recomputes from the one healthy scope', async () => {
    // Workspace open, project `grim context` probe failed (projectProbeFailed —
    // and crucially NO snap.error), global healthy with ONE outdated install.
    // The banner says install state is unavailable, so the update badge must
    // stay frozen: a count from the single known scope would undercount. Gated
    // on `firstUnknown === undefined`, not `snap.error === undefined`.
    const snapshot: Snapshot = {
      grimMissing: false,
      projectFolder: '/work/my-app',
      projectProbeFailed: true,
      global: {
        context: contextInfo(),
        status: [{ ...statusItem(), state: 'outdated', update_available: true }],
        declared: { 'grim-usage': `${REPO}:1.5.0` },
      },
    };
    const { provider, view } = makeSidebar([snapshot]);
    await provider.refresh();
    assert.strictEqual(
      view.badge,
      undefined,
      'the badge stays frozen — reverting the gate to snap.error would set it to the global count (1)',
    );
  });
});

suite('unknown install state: details panel', () => {
  const panels: vscode.WebviewPanel[] = [];
  const disposables: vscode.Disposable[] = [];

  teardown(() => {
    for (const panel of panels.splice(0)) {
      panel.dispose();
    }
    for (const d of disposables.splice(0)) {
      d.dispose();
    }
  });

  test('a scope whose install state is unknown gets no install affordance (A2)', () => {
    // Project status is unknown, global is known and holds the artifact. The
    // panel must stay silent about project and honest about global — the
    // failure being pinned is the opposite: project renders "Not installed"
    // plus an Install button for an artifact that may well be installed there.
    const snapshot: Snapshot = {
      grimMissing: false,
      projectFolder: '/work/my-app',
      project: {
        context: contextInfo({ scope: 'project', workspace: '/work/my-app' }),
        status: null,
        statusUnknownReason: 'status-failed',
        declared: { 'grim-usage': `${REPO}:1.5.0` },
      },
      global: knownScope(),
    };
    const scopes = {
      cachedSnapshot: (): Snapshot => snapshot,
      projectFolder: (): string => '/work/my-app',
    } as unknown as ScopeService;
    const catalog = {
      state: (): CatalogState => ({ items: [searchItem()], syncedAt: Date.now() }),
    } as unknown as CatalogService;
    const output = vscode.window.createOutputChannel('grimoire-details-test');
    disposables.push(output);
    const manager = new DetailsManager(
      vscode.Uri.file(path.join(os.tmpdir(), 'grimoire-ext')),
      scopes,
      catalog,
      async () => {},
      output,
      async () => {},
      path.join(os.tmpdir(), 'grimoire-details-cache-spec'),
    );

    manager.openPreview(REPO);
    const panel = manager.previewPanel;
    assert.ok(panel, 'the preview panel opened');
    panels.push(panel);
    const html = normalizeHtml(panel.webview.html);

    assert.ok(
      !html.includes('data-action="install" data-scope="project"'),
      'no Install button for a scope whose install state is unknown',
    );
    assert.ok(
      !html.includes('Not installed'),
      'the panel makes no "not installed" claim about the unknown scope',
    );
    // The known scope is unaffected — the suppression is per scope, not a
    // blanket blanking of the box.
    assert.ok(html.includes('data-action="uninstall"'), 'the known global install still renders');
    assert.ok(html.includes('1.5.0'), 'with its version');
  });

  /** A DetailsManager over doubles for the full build pipeline: `run` fails
   *  every describe/fetch (content is irrelevant here — the install rows are),
   *  so buildVM reaches assembleVM with the given snapshot. */
  function makeManager(snapshot: Snapshot): DetailsManager {
    const errored: GrimResult<never> = {
      ok: false,
      kind: 'error',
      code: 'offline',
      exitCode: 1,
      message: 'offline',
    };
    const scopes = {
      snapshot: async (): Promise<Snapshot> => snapshot,
      cachedSnapshot: (): Snapshot => snapshot,
      projectFolder: (): string | undefined => snapshot.projectFolder,
      run: async (): Promise<GrimResult<never>> => errored,
    } as unknown as ScopeService;
    const catalog = {
      state: (): CatalogState => ({ items: [searchItem()], syncedAt: Date.now() }),
    } as unknown as CatalogService;
    const output = vscode.window.createOutputChannel('grimoire-details-test');
    disposables.push(output);
    return new DetailsManager(
      vscode.Uri.file(path.join(os.tmpdir(), 'grimoire-ext')),
      scopes,
      catalog,
      async () => {},
      output,
      async () => {},
      path.join(os.tmpdir(), 'grimoire-details-cache-spec'),
    );
  }

  test('the LIVE assembleVM paint suppresses the unknown scope too (A2, rev-tests#2)', async () => {
    // The skeleton case above pins the SSR first-paint; this one reaches the
    // live paint (buildVM → assembleVM), so reverting assembleVM's unknown-scope
    // stamping — not just the skeleton's — is caught. Project unknown, global
    // known and installed.
    const snapshot: Snapshot = {
      grimMissing: false,
      projectFolder: '/work/my-app',
      project: {
        context: contextInfo({ scope: 'project', workspace: '/work/my-app' }),
        status: null,
        statusUnknownReason: 'status-failed',
        declared: { 'grim-usage': `${REPO}:1.5.0` },
      },
      global: knownScope(),
    };
    const vm = await makeManager(snapshot).buildVM(REPO);
    const html = normalizeHtml(await litString(renderDetails(vm)));

    assert.ok(
      !html.includes('data-action="install" data-scope="project"'),
      'no Install button for the unknown project scope in the live paint',
    );
    assert.ok(
      !html.includes('Not installed'),
      'the live paint makes no "not installed" claim about the unknown scope',
    );
    assert.ok(html.includes('Install state unknown'), 'the unknown project row is labelled as such');
    // Global stays honest — the suppression is per scope.
    assert.ok(html.includes('data-action="uninstall"'), 'the known global install still renders');
    assert.ok(html.includes('1.5.0'), 'with its version');
  });

  test('installSlice distinguishes an empty scope from an unknown one (Codex#1)', () => {
    // The warm-repost leak: installsFor returned `[]` for BOTH "nothing
    // installed" and "unknown", so a scope flipping empty→unknown produced an
    // equal slice and the stale "Not installed" paint stuck. installSlice now
    // stringifies `unknown` too, so the two must differ.
    const manager = makeManager(healthySnapshot());
    const empty: Snapshot = {
      grimMissing: false,
      global: { context: contextInfo(), status: [], declared: {} },
    };
    const unknown: Snapshot = {
      grimMissing: false,
      global: {
        context: contextInfo(),
        status: null,
        statusUnknownReason: 'status-failed',
        declared: {},
      },
    };
    assert.notStrictEqual(
      manager.installSlice(REPO, empty),
      manager.installSlice(REPO, unknown),
      'an empty scope and an unknown scope must produce different slices',
    );
  });
});
