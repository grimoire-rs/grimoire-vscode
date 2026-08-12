// Specification tests for plan_update-badge-review-findings — written before
// the fixes, so most of these FAIL until the clusters land. They pin the parts
// of the update-count story that live on the extension-host side: the count is
// published without a resolved webview view (cluster B), a post that races the
// webview's boot survives it (cluster D), and the activity-bar row and its
// badge say the same thing (cluster F). Persistence scope (cluster C1/C2) is
// asserted against the injected store rather than through an activation.
import * as assert from 'assert';
import * as os from 'os';
import * as vscode from 'vscode';
import type { CatalogService, CatalogState } from '../catalog';
import type { GrimoireApi } from '../extension';
import { mementoCheckStore } from '../extension';
import type { ContextInfo, GrimResult, SearchItem, StatusItem } from '../grim';
import type { CheckedFields, ScopeService, Snapshot } from '../scopes';
import { SidebarProvider, type SidebarDelegate } from '../views/sidebar';
import type { HostToSidebar } from '../webview/protocol';
import type { CachedCardMeta } from '../detailsCache';

const REPO = 'ghcr.io/grimoire-rs/skills/badged';

function contextInfo(): ContextInfo {
  return {
    version: '99.0.0',
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
  };
}

function statusItem(overrides: Partial<StatusItem> = {}): StatusItem {
  return {
    kind: 'skill',
    name: 'badged',
    source: 'direct',
    pinned: `${REPO}:1.0.0`,
    state: 'installed',
    outputs: [],
    clients_missing: [],
    clients_extra: [],
    deprecated: null,
    replaced_by: null,
    update_available: null,
    ...overrides,
  };
}

function searchItem(): SearchItem {
  return {
    kind: 'skill',
    repo: REPO,
    summary: null,
    description: 'A skill.',
    version: '1.0.0',
    latest_tag: null,
    repository: null,
    revision: null,
    created: null,
    deprecated: null,
    status: 'not-installed',
  };
}

/** One global install that grim's `--check` says has an update — so the count
 *  the sidebar computes is exactly 1. */
function outdatedSnapshot(): Snapshot {
  return {
    grimMissing: false,
    global: {
      context: contextInfo(),
      status: [statusItem({ state: 'outdated', update_available: true })],
      declared: {},
    },
  };
}

/** Records every message the host posts at the webview. */
function fakeView(posted: HostToSidebar[]): vscode.WebviewView {
  const noopEvent = (): vscode.Disposable => ({ dispose: () => {} });
  const view = {
    viewType: 'grimoire.marketplace',
    visible: true,
    show: () => {},
    onDidDispose: noopEvent,
    onDidChangeVisibility: noopEvent,
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

interface SidebarHarness {
  provider: SidebarProvider;
  /** Every message that reached the webview, in order. */
  posted: HostToSidebar[];
  /** Every count the provider published, in order. */
  counts: number[];
}

/** A SidebarProvider over doubles. `resolve` false leaves the WebviewView
 *  unresolved — the state a window whose Grimoire container was never opened is
 *  in, and the one the count must survive. */
function makeSidebar(options: {
  snapshots: Snapshot[];
  catalogStates?: CatalogState[];
  resolve?: boolean;
}): SidebarHarness {
  const snapshots = [...options.snapshots];
  let lastSnapshot = snapshots[0] ?? { grimMissing: false };
  const catalogStates = [...(options.catalogStates ?? [])];
  let lastCatalog: CatalogState = catalogStates[0] ?? { items: [searchItem()], syncedAt: 0 };
  const scopes = {
    snapshot: async (): Promise<Snapshot> => {
      lastSnapshot = snapshots.shift() ?? lastSnapshot;
      return lastSnapshot;
    },
    resolvedExecutable: () => ({ path: 'grim', origin: 'PATH' as const }),
  } as unknown as ScopeService;
  const catalog = {
    search: async (): Promise<CatalogState> => {
      lastCatalog = catalogStates.shift() ?? lastCatalog;
      return lastCatalog;
    },
  } as unknown as CatalogService;
  const counts: number[] = [];
  const delegate: SidebarDelegate = {
    openDetails: () => {},
    installGrim: async () => {},
    refreshAll: async () => {},
    pin: async () => {},
    pickVersion: async () => {},
    suspendWhile: (fn) => fn(),
    cachedCardMeta: async () => new Map<string, CachedCardMeta>(),
    forgetCached: () => {},
    prefetch: () => {},
    setUpdateCount: (count) => {
      counts.push(count);
    },
  };
  const posted: HostToSidebar[] = [];
  const output = vscode.window.createOutputChannel('grimoire-update-badge-spec');
  // A throwaway globalState: the provider stores the view preference there.
  const store = new Map<string, unknown>();
  const memento = {
    keys: () => [...store.keys()],
    get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  } as unknown as vscode.Memento;
  const provider = new SidebarProvider(
    vscode.Uri.file(os.tmpdir()),
    scopes,
    catalog,
    delegate,
    output,
    memento,
  );
  if (options.resolve !== false) {
    provider.resolveWebviewView(fakeView(posted));
  }
  return { provider, posted, counts };
}

async function activateExtension(): Promise<GrimoireApi> {
  const extension = vscode.extensions.getExtension<GrimoireApi>('grimoire-rs.grimoire-vscode');
  assert.ok(extension, 'extension not found');
  const api = await extension.activate();
  assert.ok(api, 'extension returned no API');
  return api;
}

suite('update count without a resolved webview view (cluster B)', () => {
  test('a refresh publishes the count even though no webview view was ever resolved', async () => {
    // The whole point of moving the badge off the WebviewView: VS Code resolves
    // that object only when the view first becomes visible, so a window where
    // Grimoire was never opened had no count at all. Nothing is resolved here.
    const { provider, counts } = makeSidebar({ snapshots: [outdatedSnapshot()], resolve: false });
    await provider.refresh();
    assert.deepStrictEqual(
      counts,
      [1],
      'the count is computed from the snapshot alone — a resolved view is not a precondition',
    );
  });

  test('the count the extension itself computes reaches the activity-bar badge', async function () {
    this.timeout(15000);
    // The other half of the same claim, through the REAL wiring: the extension's
    // own SidebarProvider, its own delegate, its own UpdatesView, with only grim
    // faked underneath. Wiring the harness straight to setCount would prove that
    // setCount works and nothing at all about whether anything calls it.
    const api = await activateExtension();
    const updates = api.providers.updates;
    updates.setCount(0);
    assert.strictEqual(updates.badge(), undefined, 'precondition: nothing on the icon');
    const originalRun = api.scopes.run;
    try {
      api.scopes.run = (async <T>(args: string[]): Promise<GrimResult<T>> => {
        if (args[0] === 'context') {
          return { ok: true, value: contextInfo() } as GrimResult<T>;
        }
        if (args[0] === 'status') {
          return {
            ok: true,
            value: { items: [statusItem({ state: 'outdated' })] },
          } as GrimResult<T>;
        }
        // An empty catalog: the count must not need one — and an empty browse
        // list keeps the prefetcher out of this test.
        return { ok: true, value: { items: [] } } as GrimResult<T>;
      }) as typeof api.scopes.run;
      await api.providers.sidebar.refresh();
      assert.strictEqual(
        updates.badge()?.value,
        1,
        'the count the sidebar computed reached the activity bar through the real delegate',
      );
    } finally {
      api.scopes.run = originalRun;
      updates.setCount(0);
    }
  });

  test('a catalog-side no-grim clears a count the snapshot had already published', async () => {
    // Two ways to discover grim is gone: the snapshot's own probe, and the
    // catalog search that runs after it. Only the first was covered — the
    // second left the number standing over an Updates tab rendering "no grim".
    const { provider, counts } = makeSidebar({
      snapshots: [outdatedSnapshot(), outdatedSnapshot()],
      catalogStates: [
        { items: [searchItem()], syncedAt: 0 },
        { items: [], syncedAt: null, grimMissing: true },
      ],
    });
    await provider.refresh();
    assert.deepStrictEqual(counts, [1], 'precondition: a count is up');
    await provider.refresh();
    assert.deepStrictEqual(counts, [1, 0], 'the catalog-side no-grim clears it, same as the probe');
  });
});

suite('posts that race the webview boot (cluster D)', () => {
  /** The setTab messages that actually reached the webview. */
  const setTabs = (posted: HostToSidebar[]): Array<{ tab: string }> =>
    posted.flatMap((m) => (m.type === 'setTab' ? [{ tab: m.tab }] : []));

  test('a setTab posted before the webview says ready is delivered, not dropped', async () => {
    // A resolved postMessage does NOT mean delivered (@types/vscode: "the
    // message can only be delivered if the webview is live"), so the Updates
    // row's click-through was silently lost whenever it beat the boot.
    const { provider, posted } = makeSidebar({ snapshots: [outdatedSnapshot()] });
    provider.showTab('updates');
    assert.deepStrictEqual(
      setTabs(posted),
      [],
      'a post issued while the webview is still booting is held, not fired into the void',
    );

    await provider.handleMessage({ type: 'ready' });
    assert.deepStrictEqual(
      setTabs(posted),
      [{ tab: 'updates' }],
      'and it lands exactly once the webview reports ready',
    );
  });

  test('repeated clicks on the Updates row queue at most one setTab', async () => {
    // A user clicking the row while the container boots must not make the
    // webview replay N tab switches. One per type, most recent wins.
    const { provider, posted } = makeSidebar({ snapshots: [outdatedSnapshot()] });
    provider.showTab('installed');
    provider.showTab('updates');
    provider.showTab('installed');
    provider.showTab('updates');

    await provider.handleMessage({ type: 'ready' });
    assert.deepStrictEqual(
      setTabs(posted),
      [{ tab: 'updates' }],
      'one setTab, carrying the tab the user asked for last',
    );
  });

  test("a post after the view is re-resolved waits for the new webview's ready", async () => {
    // Re-resolution is routine, not a one-off: without retainContextWhenHidden
    // VS Code disposes a hidden view and resolves a fresh one when it comes
    // back. That new webview process has not said `ready`, so a handshake flag
    // left up from the last one fires the next boot's posts into something that
    // is not listening — the same silent drop, one boot later.
    const { provider } = makeSidebar({ snapshots: [outdatedSnapshot()] });
    await provider.handleMessage({ type: 'ready' });

    const reposted: HostToSidebar[] = [];
    provider.resolveWebviewView(fakeView(reposted));
    provider.showTab('updates');
    assert.deepStrictEqual(
      setTabs(reposted),
      [],
      'the fresh webview is booting — the post is held, not fired at it',
    );

    await provider.handleMessage({ type: 'ready' });
    assert.deepStrictEqual(
      setTabs(reposted),
      [{ tab: 'updates' }],
      'and it lands exactly once, when the NEW webview reports ready',
    );
  });

  test('a focusSearch and a setTab that both raced the boot both survive it', async () => {
    // "At most one" is per message type, not per queue — the deep-link handler's
    // focusSearch and the Updates row's setTab are different requests.
    const { provider, posted } = makeSidebar({ snapshots: [outdatedSnapshot()] });
    provider.focusSearch();
    provider.showTab('updates');
    assert.strictEqual(posted.length, 0, 'both are held while the webview is still booting');

    await provider.handleMessage({ type: 'ready' });
    assert.strictEqual(
      posted.filter((m) => m.type === 'focusSearch').length,
      1,
      'the focusSearch that raced the boot is delivered too (the same pre-existing race)',
    );
    assert.deepStrictEqual(setTabs(posted), [{ tab: 'updates' }], 'and so is the setTab');
  });
});

suite('the activity-bar row and its badge (cluster F)', () => {
  test('two identical counts fire one tree-data event', async function () {
    this.timeout(15000);
    // Every refresh publishes a count and most publish the same one; a watcher
    // storm must not cost a tree rebuild per event.
    const updates = (await activateExtension()).providers.updates;
    updates.setCount(0);
    let events = 0;
    const subscription = updates.onDidChangeTreeData(() => {
      events++;
    });
    try {
      updates.setCount(7);
      updates.setCount(7);
      assert.strictEqual(events, 1, 'the second identical count is a no-op');
    } finally {
      subscription.dispose();
      updates.setCount(0);
    }
  });

  test('the badge tooltip matches the row wording, singular included', async function () {
    this.timeout(15000);
    // The badge and the row it belongs to are the same claim; "1 available"
    // next to "1 update available" reads as two different numbers' units.
    const updates = (await activateExtension()).providers.updates;
    try {
      updates.setCount(1);
      assert.strictEqual(updates.badge()?.tooltip, '1 update available');
      assert.strictEqual(updates.badge()?.tooltip, updates.getTreeItem().label);
      updates.setCount(3);
      assert.strictEqual(updates.badge()?.tooltip, '3 updates available');
      assert.strictEqual(updates.badge()?.tooltip, updates.getTreeItem().label);
    } finally {
      updates.setCount(0);
    }
  });
});

suite('where remembered verdicts are persisted (cluster C1/C2)', () => {
  /** Minimal Memento double; `entries` is what a test inspects. */
  function fakeMemento(): vscode.Memento & { entries: Map<string, unknown> } {
    const entries = new Map<string, unknown>();
    return {
      entries,
      keys: () => [...entries.keys()],
      get: <T>(key: string, defaultValue?: T): T | undefined =>
        entries.has(key) ? (entries.get(key) as T) : defaultValue,
      update: (key: string, value: unknown) => {
        entries.set(key, value);
        return Promise.resolve();
      },
    } as unknown as vscode.Memento & { entries: Map<string, unknown> };
  }

  const fields = (updateAvailable: boolean): CheckedFields => ({
    update_available: updateAvailable,
    deprecated: null,
    replaced_by: null,
  });

  test('project verdicts land in workspaceState and global ones in globalState', async () => {
    // Project verdicts are about THIS workspace's grimoire.toml. Under one
    // shared globalState record two open workspaces pruned each other's project
    // entries away (the merge self-prunes to the installed set) and the count
    // fell back to the lock proxy — the exact bug the branch fixes.
    const workspaceState = fakeMemento();
    const globalState = fakeMemento();
    const store = mementoCheckStore(workspaceState, globalState);

    await store.write('project', { 'skill|proj|1.0.0': fields(true) });
    await store.write('global', { 'skill|glob|1.0.0': fields(false) });

    assert.deepStrictEqual(Object.keys(store.read('project')), ['skill|proj|1.0.0']);
    assert.deepStrictEqual(Object.keys(store.read('global')), ['skill|glob|1.0.0']);
    assert.strictEqual(workspaceState.entries.size, 1, 'the project record is workspace-scoped');
    assert.strictEqual(globalState.entries.size, 1, 'the global one is not');
    assert.deepStrictEqual(
      [...workspaceState.entries.values()],
      [{ 'skill|proj|1.0.0': fields(true) }],
      'and neither scope can be read out of the other storage',
    );
  });

  test('a store with nothing persisted reads as no verdicts', () => {
    const store = mementoCheckStore(fakeMemento(), fakeMemento());
    assert.deepStrictEqual(store.read('project'), {});
    assert.deepStrictEqual(store.read('global'), {});
  });

  test('the verdict key is off the grim-release-check namespace', async () => {
    // `updateCheck.*` is the GitHub release check's throttle namespace. Sharing
    // it is free to fix now and stale-key debt after the release ships.
    const globalState = fakeMemento();
    const store = mementoCheckStore(fakeMemento(), globalState);
    await store.write('global', { 'skill|glob|1.0.0': fields(true) });
    const keys = [...globalState.entries.keys()];
    assert.strictEqual(keys.length, 1);
    assert.ok(
      keys.every((key) => !key.startsWith('updateCheck')),
      `artifact verdicts must not sit in the release-check namespace: ${keys.join(', ')}`,
    );
    assert.ok(
      keys.every((key) => key.startsWith('artifactCheck')),
      `they belong to the artifact check: ${keys.join(', ')}`,
    );
  });
});
