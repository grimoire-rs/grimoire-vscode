// Specification tests for the stale-first paint. A sidebar that has already
// painted a round — this session's, or the previous window's off disk — must
// never open on an empty skeleton while grim answers, and the catalog search
// must not queue behind the snapshot's status calls. These drive the real
// SidebarProvider with doubles and assert on the ORDER of what the user ends up
// looking at, not on which field carries it.
import * as assert from 'assert';
import * as os from 'os';
import * as vscode from 'vscode';
import type { CatalogService, CatalogState } from '../catalog';
import type { CachedCardMeta } from '../detailsCache';
import type { ContextInfo, GrimResult, SearchItem, StatusItem } from '../grim';
import { ScopeService, type ScopeSnapshot, type Snapshot } from '../scopes';
import { SidebarProvider, type SidebarDelegate } from '../views/sidebar';
import { DEFAULT_FILTER } from '../webview/model';
import type { HostToSidebar, SidebarState } from '../webview/protocol';
import { renderSidebar } from '../webview/render';
import { litString } from './litString';
import { normalizeHtml } from './normalizeHtml';

const REPO = 'ghcr.io/grimoire-rs/skills/grim-usage';
const LOGO = 'data:image/png;base64,AAAA';

/** Lets every pending microtask AND timer callback run — the seam the ordering
 *  tests use to observe what a refresh has started before it finishes. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

function globalScope(): ScopeSnapshot {
  return {
    context: contextInfo(),
    status: [statusItem()],
    declared: { 'skill:grim-usage': `${REPO}:1.5.0` },
  };
}

function healthySnapshot(): Snapshot {
  return { grimMissing: false, global: globalScope() };
}

/** A snapshot with a workspace folder whose project scope is (un)configured —
 *  the only input that moves projectSearchable, and so the search scope. */
function projectSnapshot(configured: boolean): Snapshot {
  const snapshot: Snapshot = {
    grimMissing: false,
    global: globalScope(),
    projectFolder: '/work/my-app',
  };
  if (configured) {
    snapshot.project = {
      context: contextInfo({ scope: 'project', workspace: '/work/my-app' }),
      status: [],
      declared: {},
    };
  }
  return snapshot;
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

/** Minimal WebviewView double: somewhere to post messages, an html sink, a
 *  settable badge. */
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

function statesOf(posted: HostToSidebar[]): SidebarState[] {
  return posted.flatMap((m) => (m.type === 'state' ? [m.state] : []));
}

function lastState(posted: HostToSidebar[]): SidebarState {
  const states = statesOf(posted);
  const last = states[states.length - 1];
  assert.ok(last, 'expected at least one posted state');
  return last;
}

/** A globalState double that round-trips through JSON exactly as VS Code's own
 *  does — so a blob that would not survive the real store fails here too. */
function fakeMemento(store: Map<string, unknown> = new Map()): {
  memento: vscode.Memento;
  store: Map<string, unknown>;
} {
  const memento = {
    keys: () => [...store.keys()],
    get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
    update: async (key: string, value: unknown) => {
      store.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    },
  } as unknown as vscode.Memento;
  return { memento, store };
}

interface Harness {
  provider: SidebarProvider;
  posted: HostToSidebar[];
  store: Map<string, unknown>;
  /** `projectConfigured` of every catalog.search call, in order. */
  searches: boolean[];
  /** Re-resolves the provider onto a FRESH webview, as VS Code does when a
   *  hidden view comes back, and returns that webview's own post log. */
  reopen: () => HostToSidebar[];
}

function makeSidebar(
  options: {
    snapshot?: Snapshot;
    /** What ScopeService.cachedSnapshot() reports (undefined = cold window). */
    cachedSnapshot?: Snapshot;
    projectFolder?: string;
    probe?: boolean;
    store?: Map<string, unknown>;
    logo?: boolean;
    /** Awaited inside the snapshot double — the ordering seam. */
    snapshotGate?: Promise<void>;
    searchGate?: Promise<void>;
  } = {},
): Harness {
  const searches: boolean[] = [];
  const scopes = {
    snapshot: async (): Promise<Snapshot> => {
      if (options.snapshotGate) {
        await options.snapshotGate;
      }
      return options.snapshot ?? healthySnapshot();
    },
    cachedSnapshot: (): Snapshot | undefined => options.cachedSnapshot,
    projectFolder: (): string | undefined => options.projectFolder,
    projectSearchableProbe: async (): Promise<boolean> => options.probe === true,
    resolvedExecutable: () => ({ path: 'grim', origin: 'PATH' as const }),
  } as unknown as ScopeService;
  const catalog = {
    search: async (
      _query: string,
      searchOptions: { projectConfigured?: boolean } = {},
    ): Promise<CatalogState> => {
      searches.push(searchOptions.projectConfigured === true);
      if (options.searchGate) {
        await options.searchGate;
      }
      return { items: [searchItem()], syncedAt: Date.now() };
    },
  } as unknown as CatalogService;
  const delegate: SidebarDelegate = {
    openDetails: () => {},
    installGrim: async () => {},
    refreshAll: async () => {},
    pin: async () => {},
    pickVersion: async () => {},
    suspendWhile: (fn) => fn(),
    cachedCardMeta: async () =>
      options.logo === true
        ? new Map<string, CachedCardMeta>([[REPO, { logoUri: LOGO, version: null }]])
        : new Map<string, CachedCardMeta>(),
    expireCached: () => {},
    prefetch: () => {},
  };
  const posted: HostToSidebar[] = [];
  const output = vscode.window.createOutputChannel('grimoire-test');
  const { memento, store } = fakeMemento(options.store);
  const provider = new SidebarProvider(
    vscode.Uri.file(os.tmpdir()),
    scopes,
    catalog,
    delegate,
    output,
    memento,
  );
  provider.resolveWebviewView(fakeView(posted));
  return {
    provider,
    posted,
    store,
    searches,
    reopen: () => {
      const fresh: HostToSidebar[] = [];
      provider.resolveWebviewView(fakeView(fresh));
      return fresh;
    },
  };
}

suite('stale-first paint: boot replay', () => {
  test('a re-resolved webview repaints the last round before the refresh runs', async () => {
    const harness = makeSidebar();
    await harness.provider.refresh();

    // VS Code disposes a hidden view and resolves a new one when it comes back;
    // the new webview has painted nothing at all.
    const fresh = harness.reopen();
    await harness.provider.handleMessage({ type: 'ready' });

    const states = statesOf(fresh);
    const first = states[0];
    assert.ok(first, 'the reopened view must be handed a state');
    assert.strictEqual(first.phase, 'ready', 'the boot must not open on a skeleton');
    assert.strictEqual(first.items.length, 1);
    assert.strictEqual(
      first.stale,
      undefined,
      'a round from THIS session is verified — only a disk restore is stale',
    );
    assert.ok(
      states.some((s) => s.phase === 'loading'),
      'the refresh still runs behind the replayed round',
    );
    assert.strictEqual(lastState(fresh).phase, 'ready');
  });
});

suite('stale-first paint: restored from storage', () => {
  test('a cold window paints the previous window’s round, marked stale', async () => {
    const first = makeSidebar({ logo: true });
    await first.provider.refresh();

    // A new window: same globalState, nothing in memory.
    const second = makeSidebar({ store: first.store, logo: true });
    await second.provider.handleMessage({ type: 'ready' });

    const states = statesOf(second.posted);
    const restored = states[0];
    assert.ok(restored, 'a cold window with a stored round must paint it');
    assert.strictEqual(restored.phase, 'ready');
    assert.strictEqual(restored.stale, true, 'last session’s install state is not verified');
    assert.strictEqual(restored.items.length, 1);
    assert.strictEqual(lastState(second.posted).stale, undefined, 'the fresh round clears it');
  });

  test('logos are not persisted — the details cache re-supplies them', async () => {
    const first = makeSidebar({ logo: true });
    await first.provider.refresh();

    const stored = first.store.get('grimoire.sidebar.lastResults') as {
      cards: { logoUri?: string | null }[];
    };
    assert.ok(stored, 'the round must be stored');
    assert.strictEqual(
      stored.cards[0]?.logoUri,
      undefined,
      'a data: URI of the whole image has no business in globalState',
    );

    const second = makeSidebar({ store: first.store, logo: true });
    await second.provider.handleMessage({ type: 'ready' });
    const restored = statesOf(second.posted)[0];
    assert.strictEqual(restored?.items[0]?.logoUri, LOGO, 'the details cache puts it back');
  });

  test('a round searched in another workspace folder is not restored', async () => {
    const first = makeSidebar({ projectFolder: '/work/one' });
    await first.provider.refresh();

    const second = makeSidebar({ store: first.store, projectFolder: '/work/two' });
    await second.provider.handleMessage({ type: 'ready' });

    const states = statesOf(second.posted);
    assert.strictEqual(
      states[0]?.phase,
      'loading',
      'another folder browses another registry set — these cards would be a lie',
    );
  });

  test('a blob from an older shape paints nothing instead of throwing', async () => {
    const store = new Map<string, unknown>([['grimoire.sidebar.lastResults', { cards: 'nope' }]]);
    const harness = makeSidebar({ store });
    await harness.provider.handleMessage({ type: 'ready' });
    assert.strictEqual(statesOf(harness.posted)[0]?.phase, 'loading');
  });

  test('a filtered round is never written — only the unfiltered browse list', async () => {
    const harness = makeSidebar();
    await harness.provider.handleMessage({ type: 'search', query: 'yaml' });
    assert.strictEqual(harness.store.get('grimoire.sidebar.lastResults'), undefined);
  });
});

suite('stale-first paint: render', () => {
  async function render(state: SidebarState): Promise<string> {
    return normalizeHtml(await litString(renderSidebar(state, DEFAULT_FILTER)));
  }

  function readyState(overrides: Partial<SidebarState> = {}): SidebarState {
    return {
      phase: 'ready',
      mode: 'browse',
      query: '',
      items: [
        {
          repo: REPO,
          name: 'grim-usage',
          kind: 'skill',
          description: 'Drive the grim CLI.',
          registryHost: 'ghcr.io',
          latestVersion: '1.5.0',
          state: 'not-installed',
          deprecated: null,
          replacedBy: null,
          installs: [],
        },
      ],
      installedItems: [],
      scopes: { projectOpen: false, projectConfigured: false, projectName: null },
      registries: [],
      syncedAt: Date.now(),
      now: Date.now(),
      ...overrides,
    };
  }

  test('a stale round shows a progress bar and no Install button', async () => {
    const html = await render(readyState({ stale: true }));
    assert.ok(html.includes('<vscode-progress-bar>'), 'the refresh behind it must be visible');
    assert.ok(
      !html.includes('data-action="install"'),
      'last session’s install state must not offer to install what is installed',
    );
  });

  test('a fresh round keeps its affordances and shows no bar', async () => {
    const html = await render(readyState());
    assert.ok(!html.includes('<vscode-progress-bar>'));
    assert.ok(html.includes('data-action="install"'));
  });
});

suite('search runs in parallel with the snapshot', () => {
  test('the search starts before the snapshot resolves', async () => {
    let release!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeSidebar({ snapshotGate });

    const refreshing = harness.provider.refresh();
    await tick();
    assert.deepStrictEqual(
      harness.searches,
      [false],
      'a cold catalog pull must not queue behind grim status',
    );
    release();
    await refreshing;
  });

  test('a cached snapshot answers the scope question without a probe', async () => {
    let probes = 0;
    const harness = makeSidebar({
      cachedSnapshot: projectSnapshot(true),
      snapshot: projectSnapshot(true),
      projectFolder: '/work/my-app',
    });
    // Re-wire the probe so a call is observable: the cached snapshot must make
    // it unnecessary in the steady state.
    const scopes = (harness.provider as unknown as { scopes: ScopeService }).scopes;
    scopes.projectSearchableProbe = async (): Promise<boolean> => {
      probes += 1;
      return true;
    };

    await harness.provider.refresh();
    assert.strictEqual(probes, 0, 'the cached snapshot already knows the scope');
    assert.deepStrictEqual(harness.searches, [true], 'and it searched project scope');
  });

  test('a scope guess that missed re-runs the search', async () => {
    // The cached snapshot has no project scope (global fallback); the fresh one
    // does — a grimoire.toml appeared since. The first results are the wrong
    // registry set's.
    const harness = makeSidebar({
      cachedSnapshot: projectSnapshot(false),
      snapshot: projectSnapshot(true),
      projectFolder: '/work/my-app',
    });
    await harness.provider.refresh();
    assert.deepStrictEqual(harness.searches, [false, true]);
  });
});

suite('ScopeService.projectSearchableProbe', () => {
  function probeWith(result: GrimResult<ContextInfo>, folder: string | undefined): ScopeService {
    const output = vscode.window.createOutputChannel('grimoire-test');
    const scopes = new ScopeService({ fsPath: '/tmp/unused' } as never, output);
    scopes.projectFolder = (): string | undefined => folder;
    scopes.run = (async () => result) as ScopeService['run'];
    return scopes;
  }

  const ok = (configExists: boolean): GrimResult<ContextInfo> => ({
    ok: true,
    value: contextInfo({ scope: 'project', config_exists: configExists }),
  });

  const failed = (code: string): GrimResult<ContextInfo> => ({
    ok: false,
    kind: 'error',
    code,
    exitCode: 79,
    message: 'no grimoire.toml found by walking up',
  });

  test('a configured project is searchable', async () => {
    assert.strictEqual(await probeWith(ok(true), '/work').projectSearchableProbe(), true);
  });

  test('an unconfigured project falls back to global', async () => {
    assert.strictEqual(await probeWith(ok(false), '/work').projectSearchableProbe(), false);
  });

  test('grim’s NotDiscovered reads as unconfigured, not as a failure', async () => {
    assert.strictEqual(
      await probeWith(failed('not-found'), '/work').projectSearchableProbe(),
      false,
    );
  });

  test('any OTHER probe failure stays on project scope so it surfaces', async () => {
    // Matches snapshot()'s own projectProbeFailed rule: falling back to global
    // here would hide the failure behind someone else's registry set.
    assert.strictEqual(await probeWith(failed('io-error'), '/work').projectSearchableProbe(), true);
  });

  test('no workspace folder is never project scope', async () => {
    assert.strictEqual(await probeWith(ok(true), undefined).projectSearchableProbe(), false);
  });
});
