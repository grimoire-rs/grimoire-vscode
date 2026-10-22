// The sidebar host's side of paged Browse: the walker that loads every page
// after the first and posts each as an append. These drive the real
// SidebarProvider with doubles for grim and the catalog, so the guards (one
// loop, pause on refresh or a hidden view, stop on failure, Retry token) are
// pinned without a stub binary.
import * as assert from 'assert';
import * as os from 'os';
import * as vscode from 'vscode';
import { CatalogService, type CatalogState, type LoadResult } from '../catalog';
import type { CachedCardMeta } from '../detailsCache';
import type { ContextInfo, GrimResult, SearchEnvelope, SearchItem } from '../grim';
import type { ScopeService, Snapshot } from '../scopes';
import { SidebarProvider, type SidebarDelegate } from '../views/sidebar';
import type { HostToSidebar, PagingState, SidebarState } from '../webview/protocol';

type Append = Extract<HostToSidebar, { type: 'append' }>;

const PAGE = 'ghcr.io/grimoire-rs/skills/paged-';

function context(): ContextInfo {
  return {
    version: '0.15.0',
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

function healthy(): Snapshot {
  return {
    grimMissing: false,
    global: { context: context(), status: [], declared: {} },
  };
}

/** `grim status` failed for the global scope: browsing works, install state is unknown. */
function statusFailed(): Snapshot {
  return {
    grimMissing: false,
    global: {
      context: context(),
      status: null,
      statusUnknownReason: 'status-failed',
      declared: {},
    },
    error: 'grim status failed.',
  };
}

function row(n: number): SearchItem {
  return {
    kind: 'skill',
    repo: `${PAGE}${n}`,
    summary: null,
    description: null,
    version: null,
    latest_tag: null,
    repository: null,
    revision: null,
    created: null,
    deprecated: null,
    status: 'not-installed',
  };
}

interface Controls {
  /** Holds the next `search` / `loadNext` until the test opens the gate. */
  hold: { search?: Promise<void> | undefined; loadNext?: Promise<void> | undefined };
  /** Fails the next `loadNext` calls with this message. */
  failWith: { message?: string };
  /** A search over a list that is already complete reloads behind it. */
  reload: boolean;
  /** The list completes right after a search took its snapshot, as a page that
   *  was already in flight does when it lands mid-refresh. */
  landAfterSnapshot: boolean;
  /** The search reports a partial catalog (a source that did not load). */
  warn: boolean;
  /** The incomplete lines the nth `loadNext` call (1-based) reports, if any. */
  pageIncomplete: ((call: number) => string[] | undefined) | undefined;
  loadNextCalls: number;
  inFlight: number;
  maxInFlight: number;
}

/** A catalog that pages: each search starts a new list of one row, and each
 *  accepted loadNext appends one more, up to `total`. Either call can be held. */
function pagedCatalog(
  total: number,
  paged: boolean,
): { catalog: CatalogService; controls: Controls } {
  let items: SearchItem[] = [];
  let token = 0;
  let shadow: { items: SearchItem[]; token: number } | null = null;
  const controls: Controls = {
    hold: {},
    failWith: {},
    reload: false,
    landAfterSnapshot: false,
    warn: false,
    pageIncomplete: undefined,
    loadNextCalls: 0,
    inFlight: 0,
    maxInFlight: 0,
  };
  const paging = (): PagingState | undefined =>
    paged
      ? { token, loaded: items.length, total, lowerBound: false, hasMore: items.length < total }
      : undefined;
  // The real catalog joins the loader's lines into every page's verdict, so a
  // source that stays down is reported by each page, not by the first alone.
  const warned = ['down: registry unreachable'];
  const state = (): CatalogState => {
    const current = paging();
    return {
      items: items.slice(),
      syncedAt: 1,
      ...(current ? { paging: current } : {}),
      ...(controls.warn ? { incomplete: warned } : {}),
    };
  };
  const catalog = {
    search: async (): Promise<CatalogState> => {
      await controls.hold.search;
      if (controls.reload && items.length >= total) {
        shadow = { items: [row(0)], token: token + 1 };
        return state();
      }
      token += 1;
      items = [row(0)];
      const snapshot = state();
      if (controls.landAfterSnapshot) {
        items = Array.from({ length: total }, (_, n) => row(n));
      }
      return snapshot;
    },
    state,
    paging,
    hasMore: () => paged && (shadow !== null || items.length < total),
    rowsFrom: (index: number) => items.slice(index),
    loadNext: async (): Promise<LoadResult> => {
      const list = shadow ? shadow.token : token;
      controls.loadNextCalls += 1;
      controls.inFlight += 1;
      controls.maxInFlight = Math.max(controls.maxInFlight, controls.inFlight);
      try {
        await controls.hold.loadNext;
        if (list !== (shadow ? shadow.token : token)) {
          return { superseded: true };
        }
        if (controls.failWith.message !== undefined) {
          const error = controls.failWith.message;
          controls.failWith = {};
          return { error };
        }
        const incomplete =
          controls.pageIncomplete?.(controls.loadNextCalls) ?? (controls.warn ? warned : undefined);
        const verdict = incomplete ? { incomplete } : {};
        if (shadow) {
          shadow.items = [...shadow.items, row(shadow.items.length)];
          if (shadow.items.length < total) {
            return verdict;
          }
          ({ items, token } = { items: shadow.items, token: shadow.token });
          shadow = null;
          return { swapped: true, ...verdict };
        }
        items = [...items, row(items.length)];
        return verdict;
      } finally {
        controls.inFlight -= 1;
      }
    },
    knownItems: () => items,
    row: () => null,
    looked: () => true,
  } as unknown as CatalogService;
  return { catalog, controls };
}

/** A grim whose loader is held and whose first page lists three rows with one
 *  source down (the mark), and whose every later page read fails. The real
 *  catalog over it ends up reconciling the finished list against a grim that
 *  keeps failing. `cap` bounds the reads: a caller that keeps asking parks on
 *  the one past it, so a runaway shows as a count instead of hanging the host. */
function brokenAfterLoader(cap: number): {
  catalog: CatalogService;
  reads: () => number;
  endLoader: () => void;
} {
  let reads = 0;
  let endLoader: () => void = () => {};
  const down = { alias: 'down', locator: 'x', ok: false, error: 'unreachable', capped: false };
  const scopes = {
    projectFolder: () => undefined,
    grimVersion: async () => '0.15.0',
    run: <T>(args: string[]): Promise<GrimResult<T>> => {
      if (args.includes('--limit') && args[args.indexOf('--limit') + 1] === '1') {
        return new Promise((resolve) => {
          endLoader = () => resolve({ ok: true, value: { items: [] } } as GrimResult<T>);
        });
      }
      reads += 1;
      if (reads === 1) {
        const value: SearchEnvelope = {
          items: [row(0), row(1), row(2)],
          total: 3,
          sources: [down],
        };
        return Promise.resolve({ ok: true, value } as GrimResult<T>);
      }
      if (reads > cap) {
        return new Promise(() => {});
      }
      return Promise.resolve({
        ok: false,
        kind: 'error',
        code: 'failure',
        exitCode: 1,
        message: 'boom',
      });
    },
  } as unknown as ScopeService;
  return {
    catalog: new CatalogService(scopes, 1),
    reads: () => reads,
    endLoader: () => endLoader(),
  };
}

function makeSidebar(
  snapshots: Snapshot[],
  options: {
    total?: number;
    paged?: boolean;
    /** The real catalog over a scripted grim, in place of the paging double. */
    catalog?: CatalogService;
  } = {},
): {
  provider: SidebarProvider;
  posted: HostToSidebar[];
  controls: Controls;
  /** Every line the provider wrote to its output channel. */
  lines: string[];
  /** The webview is disposed: VS Code does this to a hidden view. */
  dispose: () => void;
  /** A fresh webview resolves for the same provider. */
  resolveAgain: () => void;
} {
  const queue = [...snapshots];
  let last = queue[0] ?? healthy();
  const scopes = {
    snapshot: async (): Promise<Snapshot> => {
      last = queue.shift() ?? last;
      return last;
    },
    resolvedExecutable: () => ({ path: 'grim', origin: 'bundled' }),
    cachedSnapshot: () => undefined,
    projectFolder: () => undefined,
    projectSearchableProbe: async () => false,
  } as unknown as ScopeService;
  const { catalog: double, controls } = pagedCatalog(options.total ?? 4, options.paged ?? true);
  const catalog = options.catalog ?? double;
  const delegate: SidebarDelegate = {
    openDetails: () => {},
    installGrim: async () => {},
    refreshAll: async () => {},
    pin: async () => {},
    pickVersion: async () => {},
    suspendWhile: (fn) => fn(),
    cachedCardMeta: async () => new Map<string, CachedCardMeta>(),
    expireCached: () => {},
    prefetch: () => {},
  };
  const store = new Map<string, unknown>();
  const memento = {
    keys: () => [...store.keys()],
    get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  } as unknown as vscode.Memento;
  const posted: HostToSidebar[] = [];
  const lines: string[] = [];
  let onDispose: () => void = () => {};
  const view = {
    viewType: 'grimoire.sidebar',
    visible: true,
    show: () => {},
    onDidDispose: (listener: () => void): vscode.Disposable => {
      onDispose = listener;
      return { dispose: () => {} };
    },
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    badge: undefined,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: (message: HostToSidebar) => {
        // Serialized at the call, as VS Code does: the host keeps growing the
        // arrays a state post referenced.
        posted.push(structuredClone(message));
        return Promise.resolve(true);
      },
    },
  } as unknown as vscode.WebviewView;
  const provider = new SidebarProvider(
    vscode.Uri.file(os.tmpdir()),
    scopes,
    catalog,
    delegate,
    { appendLine: (line: string) => lines.push(line) } as unknown as vscode.OutputChannel,
    memento,
  );
  provider.resolveWebviewView(view);
  return {
    provider,
    posted,
    controls,
    lines,
    dispose: () => onDispose(),
    resolveAgain: () => provider.resolveWebviewView(view),
  };
}

function states(posted: HostToSidebar[]): SidebarState[] {
  return posted.flatMap((m) => (m.type === 'state' ? [m.state] : []));
}

function appends(posted: HostToSidebar[]): Append[] {
  return posted.flatMap((m) => (m.type === 'append' ? [m] : []));
}

function last(posted: HostToSidebar[]): SidebarState {
  const all = states(posted);
  const state = all[all.length - 1];
  assert.ok(state, 'a state was posted');
  return state;
}

/** A promise the test settles by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets the walker run: the host starts it without awaiting it. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** What a webview would hold after replaying every message in order. */
function replay(posted: HostToSidebar[]): {
  repos: string[];
  paging: PagingState | undefined;
  incomplete: boolean;
} {
  let repos: string[] = [];
  let paging: PagingState | undefined;
  let incomplete = false;
  for (const message of posted) {
    if (message.type === 'state') {
      repos = message.state.items.map((c) => c.repo);
      paging = message.state.paging;
      incomplete = message.state.catalogIncomplete === true;
    } else if (message.type === 'append') {
      assert.strictEqual(message.offset, repos.length, 'an append continues exactly the list held');
      repos = repos.concat(message.cards.map((c) => c.repo));
      paging = message.paging;
      incomplete = message.catalogIncomplete === true;
    }
  }
  return { repos, paging, incomplete };
}

suite('paged sidebar: background page walker', () => {
  test('after the first paint the host appends every page, each at the offset already posted', async () => {
    const { provider, posted } = makeSidebar([healthy()]);
    await provider.handleMessage({ type: 'ready' });
    await until(() => replay(posted).paging?.hasMore === false, 'the list to complete');

    assert.strictEqual(last(posted).items.length, 1, 'the state carried page one only');
    const sent = appends(posted);
    assert.deepStrictEqual(
      sent.filter((a) => a.cards.length > 0).map((a) => a.offset),
      [1, 2, 3],
    );
    assert.deepStrictEqual(
      replay(posted).repos,
      [0, 1, 2, 3].map((n) => `${PAGE}${n}`),
    );
    assert.strictEqual(replay(posted).paging?.loaded, 4);
    assert.ok(sent.every((a) => a.paging.token === last(posted).paging?.token));
  });

  test('a round whose install state is unknown still loads its pages', async () => {
    const { provider, posted } = makeSidebar([statusFailed()]);
    await provider.handleMessage({ type: 'ready' });
    await until(() => replay(posted).paging?.hasMore === false, 'the list to complete');
    assert.ok(last(posted).installStateUnknown, 'precondition: the round is degraded');
    assert.strictEqual(replay(posted).repos.length, 4);
  });

  test('a new query mid-walk stops the old list: nothing is appended to it afterwards', async () => {
    const { provider, posted, controls } = makeSidebar([healthy()]);
    const page = gate();
    controls.hold.loadNext = page.promise;
    await provider.handleMessage({ type: 'ready' });
    await until(() => controls.inFlight === 1, 'a page in flight');
    const oldToken = last(posted).paging?.token;

    await provider.handleMessage({ type: 'search', query: 'x' });
    const newToken = last(posted).paging?.token;
    assert.notStrictEqual(newToken, oldToken);
    const afterState = posted.length;
    delete controls.hold.loadNext;
    page.open();
    await until(() => replay(posted).paging?.hasMore === false, 'the new list to complete');

    const after = appends(posted.slice(afterState));
    assert.ok(after.length > 0);
    assert.ok(
      after.every((a) => a.paging.token === newToken),
      'only the new list grows',
    );
    assert.deepStrictEqual(
      replay(posted).repos,
      [0, 1, 2, 3].map((n) => `${PAGE}${n}`),
    );
  });

  test('a refresh mid-walk pauses the loop, which resumes after it; never two pages in flight', async () => {
    const { provider, posted, controls } = makeSidebar([healthy()]);
    await provider.handleMessage({ type: 'ready' });
    await until(() => controls.loadNextCalls >= 1, 'the walk to start');
    const page = gate();
    controls.hold.loadNext = page.promise;
    await until(() => controls.inFlight === 1, 'a page in flight');

    const searching = gate();
    controls.hold.search = searching.promise;
    const refreshing = provider.refresh();
    delete controls.hold.loadNext;
    page.open();
    await new Promise((resolve) => setImmediate(resolve));
    searching.open();
    delete controls.hold.search;
    await refreshing;
    await until(() => replay(posted).paging?.hasMore === false, 'the list to complete again');

    assert.strictEqual(controls.maxInFlight, 1);
    assert.deepStrictEqual(
      replay(posted).repos,
      [0, 1, 2, 3].map((n) => `${PAGE}${n}`),
    );
  });

  test('a page that finishes the list between the search snapshot and the end of the refresh is still posted', async () => {
    const { provider, posted, controls } = makeSidebar([healthy()]);
    controls.landAfterSnapshot = true;
    await provider.handleMessage({ type: 'ready' });
    await until(() => replay(posted).paging?.hasMore === false, 'the list to complete');
    assert.deepStrictEqual(
      replay(posted).repos,
      [0, 1, 2, 3].map((n) => `${PAGE}${n}`),
      'the rows the snapshot missed arrive as an append',
    );
  });

  test('a partial catalog warning is posted once; later pages append without re-announcing it', async () => {
    const { provider, posted, controls } = makeSidebar([healthy()]);
    controls.warn = true;
    await provider.handleMessage({ type: 'ready' });
    await until(() => replay(posted).paging?.hasMore === false, 'the list to complete');
    const sent = appends(posted);
    assert.ok(sent.length > 0, 'precondition: pages were appended');
    assert.ok(
      sent.every((a) => a.cards.length > 0),
      'no empty append is posted just because the warning is still set',
    );
  });

  test('a partial catalog is logged once per distinct set, not on every refresh', async () => {
    const { provider, posted, controls, lines } = makeSidebar([healthy()]);
    const logged = (): string[] => lines.filter((l) => l.startsWith('sidebar: incomplete results'));
    controls.warn = true;
    await provider.handleMessage({ type: 'ready' });
    await until(() => replay(posted).paging?.hasMore === false, 'the list to complete');
    assert.strictEqual(replay(posted).incomplete, true);
    await provider.handleMessage({ type: 'search', query: 'x' });
    await provider.handleMessage({ type: 'search', query: 'y' });
    assert.deepStrictEqual(logged(), ['sidebar: incomplete results — down: registry unreachable']);
    controls.warn = false;
    await provider.handleMessage({ type: 'search', query: 'z' });
    await until(() => !replay(posted).incomplete, 'the mark to clear');
    controls.warn = true; // the same source failing again is a new episode
    await provider.handleMessage({ type: 'search', query: 'w' });
    assert.strictEqual(logged().length, 2);
  });

  test('a later page that reports an incomplete source lights the footer and is logged', async () => {
    const { provider, posted, controls, lines } = makeSidebar([healthy()]);
    controls.pageIncomplete = () => ['hub: listing incomplete'];
    await provider.handleMessage({ type: 'ready' });
    await until(() => replay(posted).paging?.hasMore === false, 'the list to complete');
    assert.strictEqual(replay(posted).incomplete, true, 'the appends carry the mark');
    assert.deepStrictEqual(
      lines.filter((l) => l.startsWith('sidebar: incomplete results')),
      ['sidebar: incomplete results — hub: listing incomplete'],
      'three pages said it; the log says it once',
    );
  });

  test('a page that read a complete catalog takes the mark down', async () => {
    const { provider, posted, controls } = makeSidebar([healthy()]);
    controls.pageIncomplete = (call) => (call === 1 ? ['hub: listing incomplete'] : undefined);
    await provider.handleMessage({ type: 'ready' });
    await until(() => replay(posted).paging?.hasMore === false, 'the list to complete');
    assert.strictEqual(replay(posted).incomplete, false);
    assert.ok(
      appends(posted).some((a) => a.catalogIncomplete === true),
      'the first page lit it',
    );
  });

  test('a reconcile that fails ends the walk after one read, keeping the rows and the mark', async () => {
    const grim = brokenAfterLoader(20);
    const { provider, posted, lines } = makeSidebar([healthy()], { catalog: grim.catalog });
    await provider.handleMessage({ type: 'ready' });
    await until(() => replay(posted).repos.length === 3, 'the first page');
    assert.strictEqual(
      replay(posted).incomplete,
      true,
      'precondition: the first page lit the mark',
    );
    assert.strictEqual(
      replay(posted).paging?.hasMore,
      true,
      'precondition: the loader keeps it open',
    );
    grim.endLoader();
    await until(() => grim.reads() >= 2, 'the reconcile to read');
    // A walker that asks again does it without yielding, so a few turns are
    // enough for it to run into the cap.
    for (let turn = 0; turn < 5; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.strictEqual(grim.reads(), 2, 'the first page and one failed reconcile, no retry loop');
    assert.deepStrictEqual(
      lines.filter((l) => l.startsWith('sidebar: loading results failed')),
      ['sidebar: loading results failed: boom'],
      'the failure is logged once',
    );
    const held = replay(posted);
    assert.strictEqual(held.repos.length, 3, 'the rows loaded stay');
    assert.strictEqual(held.incomplete, true, 'the failed read cleared nothing');
    assert.strictEqual(held.paging?.hasMore, false, 'the footer stops waiting');
    assert.strictEqual(held.paging?.failed, undefined, 'nothing to retry: the list is whole');
  });

  test('a failed page keeps the rows, posts paging.failed and stops the walker', async () => {
    const { provider, posted, controls } = makeSidebar([healthy()]);
    controls.failWith = { message: 'boom' };
    await provider.handleMessage({ type: 'ready' });
    await until(() => replay(posted).paging?.failed === true, 'the failure to be posted');
    const calls = controls.loadNextCalls;
    assert.strictEqual(calls, 1);
    assert.strictEqual(replay(posted).repos.length, 1, 'the rows loaded stay');
    assert.strictEqual(replay(posted).paging?.hasMore, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(controls.loadNextCalls, calls, 'the walker stopped');
  });

  test('retry-load with the list token resumes the walk; another token or no failure is ignored', async () => {
    const { provider, posted, controls } = makeSidebar([healthy()]);
    await provider.handleMessage({ type: 'ready' });
    await until(() => replay(posted).paging?.hasMore === false, 'the first walk to finish');
    const token = replay(posted).paging?.token ?? -1;
    await provider.handleMessage({ type: 'retry-load', token });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(controls.loadNextCalls, 3, 'no failure: nothing to retry');

    controls.failWith = { message: 'boom' };
    await provider.handleMessage({ type: 'search', query: 'y' });
    await until(() => replay(posted).paging?.failed === true, 'a failure');
    const failed = controls.loadNextCalls;
    const live = replay(posted).paging?.token ?? -1;
    await provider.handleMessage({ type: 'retry-load', token: live + 1 });
    await provider.handleMessage({ type: 'retry-load', token: Number.NaN });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(controls.loadNextCalls, failed, 'a token naming no live list is dropped');

    await provider.handleMessage({ type: 'retry-load', token: live });
    await until(() => replay(posted).paging?.hasMore === false, 'the retry to complete');
    assert.strictEqual(replay(posted).paging?.failed, undefined, 'the failure mark is cleared');
    assert.deepStrictEqual(
      replay(posted).repos,
      [0, 1, 2, 3].map((n) => `${PAGE}${n}`),
    );
  });

  test('a view that is not live loads nothing and queues nothing; its replay holds every card', async () => {
    const { provider, posted, controls, dispose, resolveAgain } = makeSidebar([healthy()]);
    const page = gate();
    controls.hold.loadNext = page.promise;
    await provider.handleMessage({ type: 'ready' });
    await until(() => controls.inFlight === 1, 'a page in flight');

    const sentBefore = appends(posted).length;
    dispose(); // VS Code disposes a hidden view
    delete controls.hold.loadNext;
    page.open();
    await until(() => controls.inFlight === 0, 'the page to land');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(controls.loadNextCalls, 1, 'no spawn for a view nobody is looking at');
    assert.strictEqual(appends(posted).length, sentBefore, 'nothing is posted to a dead webview');

    const before = posted.length;
    resolveAgain();
    await provider.handleMessage({ type: 'ready' });
    const replayed = posted.slice(before).find((m) => m.type === 'state');
    assert.ok(replayed && replayed.type === 'state');
    assert.strictEqual(replayed.state.items.length, 2, 'the boot replay holds the page');
    assert.ok(
      posted.slice(before).every((m) => m.type !== 'append' || m.offset >= 1),
      'no queued append from before the boot',
    );
    await until(() => replay(posted.slice(before)).paging?.hasMore === false, 'the walk to resume');
  });

  test('a grim that cannot page never starts a walker or posts an append', async () => {
    const { provider, posted, controls } = makeSidebar([healthy()], { paged: false });
    await provider.handleMessage({ type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(controls.loadNextCalls, 0);
    assert.strictEqual(appends(posted).length, 0);
    assert.strictEqual(last(posted).paging, undefined);
  });

  test('a reload behind a complete list posts nothing until it swaps in, then one full state', async () => {
    const { provider, posted, controls } = makeSidebar([healthy()]);
    await provider.handleMessage({ type: 'ready' });
    await until(() => replay(posted).paging?.hasMore === false, 'the list to complete');
    const token = replay(posted).paging?.token;

    controls.reload = true;
    const before = posted.length;
    const callsBefore = controls.loadNextCalls;
    await provider.refresh();
    await until(() => controls.loadNextCalls - callsBefore === 3, 'the reload to load its pages');
    await until(() => replay(posted).paging?.token !== token, 'the swap');

    const after = posted.slice(before);
    const ready = states(after).filter((st) => st.phase === 'ready');
    assert.strictEqual(ready.length, 2, 'the refresh state, then the swap');
    assert.deepStrictEqual(appends(after), [], 'no append while the list on screen is complete');
    assert.strictEqual(ready[0]?.items.length, 4, 'the list stayed whole through the refresh');
    const swapped = last(posted);
    assert.strictEqual(swapped.items.length, 4);
    assert.strictEqual(swapped.paging?.hasMore, false);
    assert.notStrictEqual(swapped.paging?.token, token);
  });
});
