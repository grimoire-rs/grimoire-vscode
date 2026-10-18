// CatalogService's shared result cache. Every view reads it, and several
// triggers can search concurrently (the search box, watcher/command refreshes,
// the details panels), so response ordering is the thing worth pinning down.
import * as assert from 'assert';
import { CatalogService, SEARCH_PAGE_SIZE, mergePage } from '../catalog';
import type { GrimResult, SearchEnvelope, SearchItem } from '../grim';
import type { ScopeService } from '../scopes';

function searchItem(overrides: Partial<SearchItem> = {}): SearchItem {
  return {
    kind: 'skill',
    repo: 'ghcr.io/grimoire-rs/skills/demo',
    summary: null,
    description: null,
    version: null,
    latest_tag: null,
    repository: null,
    revision: null,
    created: null,
    deprecated: null,
    status: 'not-installed',
    ...overrides,
  };
}

/** The online run that builds grim's disk catalog: no page, a limit of one. */
const isLoader = (args: string[]): boolean =>
  args[0] === 'search' && !args.includes('--offline') && args[args.indexOf('--limit') + 1] === '1';

/** A ScopeService stand-in whose `run` resolves when the test says so. Each
 *  in-flight search carries its OWN items, so a test can settle them in any
 *  order without the results depending on the order the settlers were built.
 *  The loader's run is answered at once unless `holdLoader`, so a test about
 *  pages sees only pages in `argv` (the loader's own argv lands in `loaderArgv`). */
function deferredScopes(
  version: string | null = '0.11.0',
  holdLoader = false,
): {
  scopes: ScopeService;
  resolveNext: (items: SearchItem[], extra?: Partial<SearchEnvelope>) => () => void;
  failNext: (message: string, overflow?: true) => () => void;
  /** Settles the oldest held loader run. */
  settleLoader: (result?: GrimResult<SearchEnvelope>) => void;
  argv: string[][];
  loaderArgv: string[][];
  runScopes: (string | undefined)[];
} {
  const pending: ((result: GrimResult<SearchEnvelope>) => void)[] = [];
  const loaders: ((result: GrimResult<SearchEnvelope>) => void)[] = [];
  const argv: string[][] = [];
  const loaderArgv: string[][] = [];
  const runScopes: (string | undefined)[] = [];
  const scopes = {
    projectFolder: () => undefined,
    grimVersion: () => Promise.resolve(version ?? undefined),
    run: <T>(args: string[], scope?: string): Promise<GrimResult<T>> =>
      new Promise((resolve) => {
        if (isLoader(args)) {
          loaderArgv.push(args);
          const settle = (result: GrimResult<SearchEnvelope>): void =>
            resolve(result as GrimResult<T>);
          if (holdLoader) {
            loaders.push(settle);
          } else {
            settle({ ok: true, value: { items: [] } });
          }
          return;
        }
        argv.push(args);
        runScopes.push(scope);
        pending.push((result) => resolve(result as GrimResult<T>));
      }),
  } as unknown as ScopeService;
  const next = (): ((result: GrimResult<SearchEnvelope>) => void) => {
    const settle = pending.shift();
    assert.ok(settle, 'no search was in flight');
    return settle;
  };
  return {
    scopes,
    argv,
    loaderArgv,
    runScopes,
    settleLoader: (result = { ok: true, value: { items: [] } }) => {
      const settle = loaders.shift();
      assert.ok(settle, 'no loader was in flight');
      settle(result);
    },
    resolveNext: (items, extra = {}) => {
      const settle = next();
      return () => settle({ ok: true, value: { items, ...extra } });
    },
    failNext: (message, overflow) => {
      const settle = next();
      return () =>
        settle({
          ok: false,
          kind: 'error',
          code: 'failure',
          exitCode: 1,
          message,
          ...(overflow ? { overflow } : {}),
        });
    },
  };
}

/** Lets a search get past its version probe and into `scopes.run`. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

suite('catalog search ordering', () => {
  test('a superseded response never overwrites the newer search results', async () => {
    const { scopes, resolveNext } = deferredScopes();
    const catalog = new CatalogService(scopes);

    const older = catalog.search('a');
    const newer = catalog.search('b');
    await flush();
    // The newer search wins the cache even though the older one lands last —
    // typing two queries quickly used to leave the first one's results cached.
    const settleOlder = resolveNext([searchItem({ repo: 'reg/old' })]);
    const settleNewer = resolveNext([searchItem({ repo: 'reg/new' })]);
    settleNewer();
    await newer;
    settleOlder();
    await older;

    assert.deepStrictEqual(
      catalog.state().items.map((i) => i.repo),
      ['reg/new'],
      'the last search to START owns the cache, not the last to FINISH',
    );
  });

  test('the caller of a superseded search still receives its own results', async () => {
    const { scopes, resolveNext } = deferredScopes();
    const catalog = new CatalogService(scopes);

    const older = catalog.search('a');
    const newer = catalog.search('b');
    await flush();
    const settleOlder = resolveNext([searchItem({ repo: 'reg/old' })]);
    const settleNewer = resolveNext([searchItem({ repo: 'reg/new' })]);
    settleNewer();
    await newer;
    settleOlder();

    // Superseded is not failed: the results are real, they just don't win the
    // shared cache.
    assert.deepStrictEqual(
      (await older).items.map((i) => i.repo),
      ['reg/old'],
    );
  });
});

suite('catalog warm', () => {
  test('warm searches once when nothing has landed, and never again after', async () => {
    const { scopes, resolveNext } = deferredScopes();
    const catalog = new CatalogService(scopes);

    // Two restored details panels warm concurrently: one spawn between them.
    const first = catalog.warm(false);
    const second = catalog.warm(false);
    await flush();
    resolveNext([searchItem({ repo: 'reg/one' })])();
    await Promise.all([first, second]);
    assert.deepStrictEqual(
      catalog.state().items.map((i) => i.repo),
      ['reg/one'],
    );

    // Warm is a no-op once a search has landed — nothing in flight to settle.
    await catalog.warm(false);
    assert.throws(() => resolveNext([]), /no search was in flight/);
  });
});

function rows(from: number, count: number): SearchItem[] {
  return Array.from({ length: count }, (_, i) => searchItem({ repo: `reg/r${from + i}` }));
}

suite('mergePage', () => {
  test('dedups on repo plus source locator, keeps cross-source duplicates', () => {
    const a = searchItem({ repo: 'reg/a', source: { alias: null, locator: 'x' } });
    const aOther = searchItem({ repo: 'reg/a', source: { alias: null, locator: 'y' } });
    const b = searchItem({ repo: 'reg/b' });
    const seen = new Set<string>();
    mergePage(seen, [a], 0, { items: [] });
    const m = mergePage(seen, [a, aOther, b], 1, { items: [] });
    assert.deepStrictEqual(m.added, [aOther, b]);
    assert.strictEqual(seen.size, 3, 'the set is updated in place');
    assert.strictEqual(m.nextOffset, 4, 'offset counts grim rows, not rows kept');
  });

  test('two sources sharing an alias are one card, so the second row is dropped', () => {
    const a = searchItem({ repo: 'reg/a', source: { alias: 'main', locator: 'x' } });
    const sameAlias = searchItem({ repo: 'reg/a', source: { alias: 'main', locator: 'y' } });
    const noSource = searchItem({ repo: 'reg/a' });
    const m = mergePage(new Set(), [a, sameAlias, noSource], 0, { items: [] });
    assert.deepStrictEqual(m.added, [a, noSource]);
  });

  test('an absent or invalid total falls back to the rows seen', () => {
    for (const total of [undefined, -1, 1.5, '9', null, Number.POSITIVE_INFINITY]) {
      const m = mergePage(new Set(), rows(0, 3), 0, { items: [], total });
      assert.strictEqual(m.total, 3, `total ${String(total)}`);
      assert.strictEqual(m.done, true);
    }
  });

  test('a total below the rows already seen is raised to them', () => {
    assert.strictEqual(mergePage(new Set(), rows(0, 5), 0, { items: [], total: 2 }).total, 5);
  });

  test('an empty page short of the claimed total means the list shrank: done', () => {
    const m = mergePage(new Set(), [], 5, { items: [], total: 9 });
    assert.strictEqual(m.total, 5);
    assert.strictEqual(m.done, true);
  });

  test('only the total or an empty page ends a list: there is no row ceiling', () => {
    const far = mergePage(new Set(), rows(0, 1_000), 49_000, { items: [], total: 90_000 });
    assert.strictEqual(far.nextOffset, 50_000);
    assert.strictEqual(far.done, false);
    assert.strictEqual(
      mergePage(new Set(), rows(0, 1_000), 89_000, { items: [], total: 90_000 }).done,
      true,
    );
  });

  test('lowerBound when a capped listing fits page one whole', () => {
    const page = rows(0, 500);
    assert.strictEqual(
      mergePage(new Set(), page, 0, { items: [], total: 500, truncated: true }).lowerBound,
      true,
    );
  });

  test('truncated alone is not a lower bound: it is set on every partial page', () => {
    const partial = mergePage(new Set(), rows(0, 200), 0, {
      items: [],
      total: 500,
      truncated: true,
    });
    assert.strictEqual(partial.lowerBound, false);
    assert.strictEqual(partial.done, false);
    const later = mergePage(new Set(), rows(400, 100), 400, {
      items: [],
      total: 500,
      truncated: true,
    });
    assert.strictEqual(later.lowerBound, false, 'only page one can prove it');
    const clean = mergePage(new Set(), rows(0, 5), 0, { items: [], total: 5, truncated: false });
    assert.strictEqual(clean.lowerBound, false);
  });

  test('lowerBound is sticky across pages', () => {
    const m = mergePage(new Set(), rows(200, 50), 200, { items: [], total: 250 }, true);
    assert.strictEqual(m.lowerBound, true);
  });

  test('a capped source in sources[] marks a lower bound on any page', () => {
    const capped = {
      items: [],
      total: 900,
      sources: [null, 3, { capped: false }, { capped: true }],
    };
    assert.strictEqual(mergePage(new Set(), rows(0, 200), 0, capped).lowerBound, true);
    const fine = { items: [], total: 900, sources: [{ capped: false }, 'x'] };
    assert.strictEqual(mergePage(new Set(), rows(0, 200), 0, fine).lowerBound, false);
  });
});

/** Answers the page grim was last asked for, from a universe of `total` rows. */
function serve(
  { argv, resolveNext }: Pick<ReturnType<typeof deferredScopes>, 'argv' | 'resolveNext'>,
  total: number,
): void {
  const args = argv[argv.length - 1] ?? [];
  const offset = Number(args[args.indexOf('--offset') + 1]);
  const limit = Number(args[args.indexOf('--limit') + 1]);
  resolveNext(rows(offset, Math.max(0, Math.min(limit, total - offset))), { total })();
}

suite('catalog paging', () => {
  test('page one is a paged online request on a grim that supports it', async () => {
    const { scopes, resolveNext, argv, loaderArgv } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const search = catalog.search('q');
    await flush();
    resolveNext(rows(0, SEARCH_PAGE_SIZE), { total: 450 })();
    const state = await search;
    assert.deepStrictEqual(argv[0], [
      'search',
      '--offline',
      '--limit',
      '200',
      '--offset',
      '0',
      '--',
      'q',
    ]);
    assert.deepStrictEqual(loaderArgv, [['search', '--limit', '1']], 'one loader builds the disk');
    assert.deepStrictEqual(state.paging, {
      token: state.paging?.token,
      loaded: 200,
      total: 450,
      lowerBound: false,
      hasMore: true,
    });
  });

  test('the Browse sort travels as --sort, relevance does not', async () => {
    const { scopes, resolveNext, argv, loaderArgv } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const first = catalog.search('', { sort: 'rating' });
    await flush();
    resolveNext([])();
    assert.strictEqual((await first).paging?.sort, 'rating');
    const second = catalog.search('', { sort: 'relevance', refresh: true });
    await flush();
    resolveNext([])();
    await second;
    assert.deepStrictEqual(argv[0], [
      'search',
      '--offline',
      '--sort',
      'rating',
      '--limit',
      '200',
      '--offset',
      '0',
    ]);
    assert.deepStrictEqual(argv[1], ['search', '--offline', '--limit', '200', '--offset', '0']);
    assert.deepStrictEqual(loaderArgv[1], ['search', '--refresh', '--limit', '1']);
  });

  test('an older or unknown grim fetches unpaged and reports no paging', async () => {
    for (const version of ['0.14.3', undefined]) {
      const { scopes, resolveNext, argv } = deferredScopes(version);
      const catalog = new CatalogService(scopes);
      const search = catalog.search('q');
      await flush();
      resolveNext(rows(0, 3))();
      const state = await search;
      assert.deepStrictEqual(argv[0], ['search', '--', 'q'], String(version));
      assert.strictEqual(state.paging, undefined);
      assert.strictEqual(catalog.state().paging, undefined);
      assert.strictEqual(catalog.paging(), undefined);
      assert.strictEqual(catalog.hasMore(), false);
      assert.deepStrictEqual(catalog.rowsFrom(0), []);
      assert.strictEqual((await catalog.loadNext()).superseded, true);
      assert.strictEqual(argv.length, 1, 'no spawn without a paged list');
    }
  });

  test('loadNext continues offline at the next offset in background-sized pages', async () => {
    const { scopes, resolveNext, argv } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const search = catalog.search('');
    await flush();
    resolveNext(rows(0, 200), { total: 2_450 })();
    await search;
    assert.strictEqual(catalog.hasMore(), true);

    const second = catalog.loadNext();
    await flush();
    resolveNext(rows(200, 1_000), { total: 2_450 })();
    assert.deepStrictEqual(await second, {});
    assert.deepStrictEqual(argv[1], ['search', '--offline', '--limit', '1000', '--offset', '200']);

    const third = catalog.loadNext();
    await flush();
    resolveNext(rows(1_200, 1_000), { total: 2_450 })();
    await third;
    assert.deepStrictEqual(argv[2], ['search', '--offline', '--limit', '1000', '--offset', '1200']);
    const fourth = catalog.loadNext();
    await flush();
    resolveNext(rows(2_200, 250), { total: 2_450 })();
    await fourth;
    assert.strictEqual(catalog.state().items.length, 2_450);
    assert.strictEqual(catalog.paging()?.hasMore, false);
    assert.strictEqual(catalog.hasMore(), false);
    assert.strictEqual(catalog.row('reg/r2449')?.repo, 'reg/r2449', 'pages feed the row index');

    assert.strictEqual((await catalog.loadNext()).superseded, true);
    assert.strictEqual(argv.length, 4, 'a finished list spawns nothing');
  });

  test('loadNext keeps the sort', async () => {
    const { scopes, resolveNext, argv } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const search = catalog.search('', { sort: 'name' });
    await flush();
    resolveNext(rows(0, 200), { total: 9_000 })();
    await search;
    const more = catalog.loadNext();
    await flush();
    assert.deepStrictEqual(argv[1], [
      'search',
      '--offline',
      '--sort',
      'name',
      '--limit',
      '1000',
      '--offset',
      '200',
    ]);
    resolveNext(rows(200, 1_000), { total: 9_000 })();
    await more;
  });

  test('a long chain of pages completes with no duplicates and no gaps, past any row ceiling', async () => {
    const stub = deferredScopes('0.15.0');
    const catalog = new CatalogService(stub.scopes);
    const TOTAL = 25_200;
    const search = catalog.search('');
    await flush();
    serve(stub, TOTAL);
    await search;
    while (catalog.hasMore()) {
      const page = catalog.loadNext();
      await flush();
      serve(stub, TOTAL);
      assert.deepStrictEqual(await page, {});
    }
    const offsets = stub.argv.map((args) => Number(args[args.indexOf('--offset') + 1]));
    assert.deepStrictEqual(
      offsets,
      Array.from({ length: 26 }, (_, i) => (i === 0 ? 0 : 200 + (i - 1) * 1_000)),
    );
    assert.deepStrictEqual(
      catalog.rowsFrom(0).map((i) => i.repo),
      rows(0, TOTAL).map((i) => i.repo),
    );
    assert.strictEqual(catalog.paging()?.loaded, TOTAL);
  });

  test('rowsFrom returns only the rows past an index, from the live list', async () => {
    const { scopes, resolveNext } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const search = catalog.search('');
    await flush();
    resolveNext(rows(0, 5), { total: 8 })();
    await search;
    assert.deepStrictEqual(
      catalog.rowsFrom(3).map((i) => i.repo),
      ['reg/r3', 'reg/r4'],
    );
    const more = catalog.loadNext();
    await flush();
    resolveNext(rows(5, 3), { total: 8 })();
    await more;
    assert.deepStrictEqual(
      catalog.rowsFrom(5).map((i) => i.repo),
      ['reg/r5', 'reg/r6', 'reg/r7'],
    );
    assert.deepStrictEqual(catalog.rowsFrom(8), []);
  });

  test('search hands back a snapshot that a later page does not grow', async () => {
    const { scopes, resolveNext } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const search = catalog.search('');
    await flush();
    resolveNext(rows(0, 2), { total: 4 })();
    const state = await search;
    const more = catalog.loadNext();
    await flush();
    resolveNext(rows(2, 2), { total: 4 })();
    await more;
    assert.strictEqual(state.items.length, 2);
    assert.strictEqual(catalog.state().items.length, 4);
  });

  suite('a search over a list already loaded', () => {
    /** A catalog holding `loaded` of `total` rows for query `q`, via the double. */
    async function loadedList(total: number, loaded: number) {
      const stub = deferredScopes('0.15.0');
      const catalog = new CatalogService(stub.scopes);
      const first = catalog.search('q');
      await flush();
      serve(stub, total);
      await first;
      while ((catalog.paging()?.loaded ?? 0) < loaded) {
        const page = catalog.loadNext();
        await flush();
        serve(stub, total);
        await page;
      }
      return { stub, catalog };
    }

    test('an unchanged first page keeps the list and spawns nothing more', async () => {
      const { stub, catalog } = await loadedList(1_200, 1_200);
      const before = catalog.state().items;
      const again = catalog.search('q');
      await flush();
      serve(stub, 1_200);
      const state = await again;
      assert.strictEqual(stub.argv.length, 2 + 1, 'page one, one background page, the repeat');
      assert.strictEqual(state.items.length, 1_200, 'every loaded row stays');
      assert.deepStrictEqual(state.items, before);
      assert.strictEqual(state.paging?.hasMore, false);
      assert.strictEqual(catalog.hasMore(), false);
    });

    test('a changed total reloads in the background and swaps in on the last page', async () => {
      const { stub, catalog } = await loadedList(1_200, 1_200);
      const token = catalog.paging()?.token;
      const again = catalog.search('q');
      await flush();
      serve(stub, 1_450);
      const state = await again;
      assert.strictEqual(state.items.length, 1_200, 'the old list stays on screen');
      assert.strictEqual(state.paging?.token, token);
      assert.strictEqual(state.paging?.total, 1_200);
      assert.strictEqual(catalog.hasMore(), true, 'the reload has pages left');

      const page = catalog.loadNext();
      await flush();
      serve(stub, 1_450);
      assert.deepStrictEqual(await page, {});
      assert.strictEqual(catalog.state().items.length, 1_200, 'still the old list mid-reload');
      assert.strictEqual(catalog.paging()?.token, token);

      const last = catalog.loadNext();
      await flush();
      serve(stub, 1_450);
      assert.deepStrictEqual(await last, { swapped: true });
      assert.strictEqual(catalog.state().items.length, 1_450);
      assert.notStrictEqual(catalog.paging()?.token, token);
      assert.strictEqual(catalog.hasMore(), false);
    });

    test('a changed head reloads even when the total is the same', async () => {
      const { stub, catalog } = await loadedList(450, 450);
      const again = catalog.search('q');
      await flush();
      const head = rows(0, 200).map((i, n) => (n === 0 ? { ...i, repo: 'reg/renamed' } : i));
      stub.resolveNext(head, { total: 450 })();
      await again;
      assert.strictEqual(catalog.hasMore(), true, 'the differing head starts a reload');
    });

    test('a list not yet complete is replaced outright by a smaller reload', async () => {
      const { stub, catalog } = await loadedList(900, 200);
      const again = catalog.search('q');
      await flush();
      serve(stub, 300);
      const state = await again;
      assert.strictEqual(state.items.length, 200);
      assert.strictEqual(state.paging?.total, 300);
    });

    test('a reload that is already complete after page one replaces the list at once', async () => {
      const { stub, catalog } = await loadedList(1_200, 1_200);
      const again = catalog.search('q');
      await flush();
      serve(stub, 100);
      const state = await again;
      assert.strictEqual(state.items.length, 100, 'a shrunken source is not left on screen');
      assert.strictEqual(catalog.hasMore(), false, 'nothing is left to promote it');
      const empty = catalog.search('q');
      await flush();
      serve(stub, 0);
      assert.strictEqual((await empty).items.length, 0);
    });

    test('a new query replaces the list and drops a reload in progress', async () => {
      const { stub, catalog } = await loadedList(1_200, 1_200);
      const reload = catalog.search('q');
      await flush();
      serve(stub, 1_450);
      await reload;
      const other = catalog.search('other');
      await flush();
      serve(stub, 300);
      const state = await other;
      assert.strictEqual(state.items.length, 200);
      assert.strictEqual(state.paging?.total, 300);
      assert.strictEqual(catalog.hasMore(), true, 'the new list, not the old reload');
      const page = catalog.loadNext();
      await flush();
      assert.ok((stub.argv[stub.argv.length - 1] ?? []).includes('other'));
      serve(stub, 300);
      assert.deepStrictEqual(await page, {});
      assert.strictEqual(catalog.state().items.length, 300);
    });

    test('a failed reload page is dropped and the visible list is untouched', async () => {
      const { stub, catalog } = await loadedList(1_200, 1_200);
      const token = catalog.paging()?.token;
      const again = catalog.search('q');
      await flush();
      serve(stub, 1_450);
      await again;
      const page = catalog.loadNext();
      await flush();
      stub.failNext('boom')();
      const result = await page;
      assert.strictEqual(result.error, 'boom');
      assert.strictEqual(result.shadow, true);
      assert.strictEqual(catalog.state().items.length, 1_200);
      assert.strictEqual(catalog.paging()?.token, token);
      assert.strictEqual(catalog.hasMore(), false, 'nothing left to load on the kept list');
    });
  });

  test('a new query, sort or scope request starts at page one', async () => {
    const { scopes, resolveNext, argv } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    for (const [options, query, flags] of [
      [{}, 'other', ['--offline', '--limit', '200', '--offset', '0', '--', 'other']],
      [
        { sort: 'name' as const },
        'other',
        ['--offline', '--sort', 'name', '--limit', '200', '--offset', '0', '--', 'other'],
      ],
    ] as const) {
      const before = argv.length;
      const restarted = catalog.search(query, options);
      await flush();
      assert.deepStrictEqual(argv[before], ['search', ...flags]);
      resolveNext(rows(0, 200), { total: 900 })();
      assert.strictEqual((await restarted).items.length, 200);
    }
  });

  test('two concurrent loadNext calls share one spawn', async () => {
    const { scopes, resolveNext, argv } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const search = catalog.search('');
    await flush();
    resolveNext(rows(0, 200), { total: 450 })();
    await search;
    const a = catalog.loadNext();
    const b = catalog.loadNext();
    await flush();
    assert.strictEqual(argv.length, 2);
    resolveNext(rows(200, 250), { total: 450 })();
    await Promise.all([a, b]);
    assert.strictEqual(catalog.state().items.length, 450);
  });

  test("a newer list does not inherit the old list's in-flight page", async () => {
    const { scopes, resolveNext, argv } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const first = catalog.search('a');
    await flush();
    resolveNext(rows(0, 200), { total: 450 })();
    await first;
    const oldPage = catalog.loadNext();
    await flush();
    const settleOld = resolveNext(rows(200, 250), { total: 450 });

    const second = catalog.search('b');
    await flush();
    resolveNext(rows(0, 200), { total: 450 })();
    await second;
    const newPage = catalog.loadNext();
    await flush();
    assert.strictEqual(argv.length, 4, 'the new list asked for its own page');
    resolveNext(rows(200, 250), { total: 450 })();
    assert.deepStrictEqual(await newPage, {});
    assert.strictEqual(catalog.state().items.length, 450);

    settleOld();
    assert.deepStrictEqual(await oldPage, { superseded: true });
    assert.strictEqual(catalog.state().items.length, 450, 'the old page never lands');
  });

  test('a page of an old query never lands on a newer list', async () => {
    const { scopes, resolveNext } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const first = catalog.search('a');
    await flush();
    resolveNext(rows(0, 200), { total: 450 })();
    await first;

    const more = catalog.loadNext();
    await flush();
    const newer = catalog.search('b');
    await flush();
    const settleOldPage = resolveNext(rows(200, 250), { total: 450 });
    const settleNewer = resolveNext([searchItem({ repo: 'reg/b1' })], { total: 1 });
    settleNewer();
    await newer;
    settleOldPage();

    assert.deepStrictEqual(await more, { superseded: true });
    assert.deepStrictEqual(
      catalog.state().items.map((i) => i.repo),
      ['reg/b1'],
    );
  });

  test('a superseded first page never becomes the list loadNext extends', async () => {
    const { scopes, resolveNext, argv } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const older = catalog.search('a');
    const newer = catalog.search('b');
    await flush();
    const settleOlder = resolveNext(rows(0, 200), { total: 450 });
    const settleNewer = resolveNext(rows(0, 3));
    settleNewer();
    await newer;
    settleOlder();
    const stale = (await older).paging;
    assert.ok(stale);
    assert.notStrictEqual(stale.token, catalog.paging()?.token);
    assert.strictEqual((await catalog.loadNext()).superseded, true, 'the newer list is complete');
    assert.strictEqual(argv.length, 2);
  });

  test('a failed page reports the error, keeps the rows and is retried at the same offset', async () => {
    const { scopes, resolveNext, failNext, argv } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const search = catalog.search('');
    await flush();
    resolveNext(rows(0, 200), { total: 450 })();
    await search;
    const more = catalog.loadNext();
    await flush();
    failNext('boom')();
    assert.deepStrictEqual(await more, { error: 'boom' });
    assert.strictEqual(catalog.state().items.length, 200);
    assert.strictEqual(catalog.paging()?.hasMore, true, 'the page can be retried');

    const retry = catalog.loadNext();
    await flush();
    assert.deepStrictEqual(argv[2], argv[1], 'the retry asks for the same offset');
    resolveNext(rows(200, 250), { total: 450 })();
    assert.deepStrictEqual(await retry, {});
    assert.strictEqual(catalog.paging()?.loaded, 450);
  });

  test('a page that wrote to stderr is reported as a warning', async () => {
    const { scopes, resolveNext } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const search = catalog.search('');
    await flush();
    resolveNext(rows(0, 200), { total: 450 })();
    await search;
    const originalRun = scopes.run.bind(scopes);
    scopes.run = (async (...args: Parameters<typeof originalRun>) => {
      const r = await originalRun(...args);
      return r.ok ? { ...r, warnings: 'source down' } : r;
    }) as typeof scopes.run;
    const more = catalog.loadNext();
    await flush();
    resolveNext(rows(200, 250), { total: 450 })();
    assert.deepStrictEqual(await more, { warnings: 'source down' });
  });

  test('an explicit refresh reads the disk again once the loader ends, and forgets known rows and lookups', async () => {
    const { scopes, resolveNext, argv, loaderArgv } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const first = catalog.search('');
    await flush();
    resolveNext([searchItem({ repo: 'reg/a' })], { total: 1 })();
    await first;
    assert.ok(catalog.row('reg/a'));

    const miss = catalog.lookup('reg/zz');
    await flush();
    resolveNext([])();
    assert.strictEqual(await miss, null);
    assert.strictEqual(await catalog.lookup('reg/zz'), null);
    assert.strictEqual(argv.length, 2, 'the miss is memoized');

    const refreshed = catalog.search('', { refresh: true });
    await flush();
    resolveNext([searchItem({ repo: 'reg/a' })], { total: 1 })(); // the stale disk
    const state = await refreshed;
    assert.deepStrictEqual(loaderArgv[1], ['search', '--refresh', '--limit', '1']);
    assert.strictEqual(state.paging?.hasMore, true, 'the list awaits what the loader wrote');
    assert.ok(catalog.row('reg/a'), 'nothing is forgotten on stale rows');

    const reread = catalog.loadNext();
    await flush();
    assert.deepStrictEqual(argv[3], ['search', '--offline', '--limit', '200', '--offset', '0']);
    resolveNext([searchItem({ repo: 'reg/b' })], { total: 1 })();
    await reread;
    assert.strictEqual(catalog.row('reg/a'), null);
    assert.ok(catalog.row('reg/b'));
    assert.strictEqual(catalog.hasMore(), false);
    assert.strictEqual(loaderArgv.length, 2, 'the read after a loader starts no loader');

    const again = catalog.lookup('reg/zz');
    await flush();
    assert.strictEqual(argv.length, 5, 'a refresh clears the memo');
    resolveNext([])();
    await again;
  });

  test('lookup asks offline for ten rows and picks the exact repo', async () => {
    const { scopes, resolveNext, argv } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const first = catalog.search('');
    await flush();
    resolveNext(rows(0, 2), { total: 2 })();
    await first;

    const lookup = catalog.lookup('reg/target');
    const again = catalog.lookup('reg/target');
    await flush();
    resolveNext([
      searchItem({ repo: 'reg/target-extras' }),
      searchItem({ repo: 'reg/target', rating: { up: 7, url: 'u' } }),
    ])();
    assert.strictEqual((await lookup)?.rating?.up, 7);
    assert.strictEqual(await again, await lookup);
    assert.deepStrictEqual(argv[1], ['search', '--offline', '--limit', '10', '--', 'reg/target']);
    assert.strictEqual(argv.length, 2, 'concurrent callers share one spawn');
    assert.strictEqual(catalog.row('reg/target')?.rating?.up, 7);
    assert.strictEqual(catalog.row('reg/target-extras'), null, 'only the exact repo is kept');
  });

  test('lookup never spawns below the paging gate', async () => {
    const { scopes, resolveNext, argv } = deferredScopes('0.14.3');
    const catalog = new CatalogService(scopes);
    const first = catalog.search('');
    await flush();
    resolveNext(rows(0, 2))();
    await first;
    assert.strictEqual(await catalog.lookup('reg/other'), null);
    assert.strictEqual(argv.length, 1);
    assert.ok(await catalog.lookup('reg/r1'), 'a row already seen still resolves');
  });

  test('lookup with an explicit scope spawns before any list exists, in that scope', async () => {
    const { scopes, resolveNext, argv, runScopes } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const lookup = catalog.lookup('reg/target', 'global');
    await flush();
    resolveNext([searchItem({ repo: 'reg/target', rating: { up: 3, url: 'u' } })])();
    assert.strictEqual((await lookup)?.rating?.up, 3);
    assert.deepStrictEqual(argv[0], ['search', '--offline', '--limit', '10', '--', 'reg/target']);
    assert.deepStrictEqual(runScopes, ['global']);
  });

  test('lookup with an explicit scope never spawns on a grim that cannot page', async () => {
    const { scopes, argv } = deferredScopes('0.14.3');
    const catalog = new CatalogService(scopes);
    assert.strictEqual(await catalog.lookup('reg/target', 'global'), null);
    assert.strictEqual(argv.length, 0);
  });
});

suite('catalog loader', () => {
  const POLL = 5;

  test('an empty disk while the loader builds is waited out, not reported as an empty registry', async () => {
    const { scopes, resolveNext, argv, settleLoader } = deferredScopes('0.15.0', true);
    const catalog = new CatalogService(scopes, POLL);
    const search = catalog.search('');
    await flush();
    resolveNext([], { total: 0 })(); // nothing checkpointed yet
    await new Promise((resolve) => setTimeout(resolve, POLL * 3));
    resolveNext(rows(0, 64), { total: 64 })(); // the first checkpoint
    const state = await search;
    assert.strictEqual(state.items.length, 64);
    assert.deepStrictEqual(
      [argv.length, state.paging?.hasMore, state.paging?.lowerBound],
      [2, true, true],
      'the loader is alive: more may follow and the total is a lower bound',
    );
    settleLoader();
  });

  test('a loader that fails with nothing on disk is the search error', async () => {
    const { scopes, resolveNext, settleLoader } = deferredScopes('0.15.0', true);
    const catalog = new CatalogService(scopes, POLL);
    const search = catalog.search('');
    await flush();
    resolveNext([])();
    settleLoader({
      ok: false,
      kind: 'error',
      code: 'unavailable',
      exitCode: 69,
      message: 'registry unreachable',
    });
    await flush();
    resolveNext([])();
    assert.strictEqual((await search).error, 'registry unreachable');
  });

  test('a query that matches nothing does not wait for the loader', async () => {
    const { scopes, resolveNext, settleLoader } = deferredScopes('0.15.0', true);
    const catalog = new CatalogService(scopes, POLL);
    const search = catalog.search('zzz');
    await flush();
    resolveNext([], { total: 0 })();
    const state = await search;
    assert.deepStrictEqual(state.items, []);
    assert.strictEqual(state.paging?.hasMore, true, 'the walker keeps looking while it builds');
    settleLoader();
  });

  test('a fully loaded list waits for the loader, then reads the disk afresh and swaps', async () => {
    const stub = deferredScopes('0.15.0', true);
    const catalog = new CatalogService(stub.scopes, POLL);
    const search = catalog.search('');
    await flush();
    serve(stub, 300);
    await search;
    const rest = catalog.loadNext();
    await flush();
    serve(stub, 300);
    await rest;
    assert.strictEqual(catalog.paging()?.loaded, 300);
    assert.strictEqual(catalog.hasMore(), true, 'the loader still runs');

    const waiting = catalog.loadNext();
    await flush();
    const before = stub.argv.length;
    stub.settleLoader(); // the loader ends: the next look is a fresh read
    const reread = waiting;
    await flush();
    assert.strictEqual(stub.argv.length, before + 1);
    serve(stub, 450); // the loader added rows
    await reread;
    assert.strictEqual(catalog.hasMore(), true, 'the grown list reloads behind the one on screen');
    const more = catalog.loadNext();
    await flush();
    serve(stub, 450);
    assert.deepStrictEqual(await more, { swapped: true });
    assert.strictEqual(catalog.state().items.length, 450);
    assert.strictEqual(catalog.hasMore(), false);
  });

  test('a repeat search within a minute starts no second loader; an explicit refresh does', async () => {
    const { scopes, resolveNext, loaderArgv, settleLoader } = deferredScopes('0.15.0', true);
    const catalog = new CatalogService(scopes, POLL);
    const a = catalog.search('a');
    await flush();
    resolveNext(rows(0, 3))();
    await a;
    const b = catalog.search('b');
    await flush();
    resolveNext(rows(0, 3))();
    await b;
    assert.strictEqual(loaderArgv.length, 1, 'one loader at a time');
    settleLoader();
    await flush();
    const c = catalog.search('c');
    await flush();
    resolveNext(rows(0, 3))();
    await c;
    assert.strictEqual(loaderArgv.length, 1, 'a loader that just settled is trusted');
    const d = catalog.search('d', { refresh: true });
    await flush();
    resolveNext(rows(0, 3))();
    await d;
    assert.deepStrictEqual(loaderArgv[1], ['search', '--refresh', '--limit', '1']);
    settleLoader();
  });

  test('a loader failure is retried by the next search, not trusted for a minute', async () => {
    const { scopes, resolveNext, loaderArgv, settleLoader } = deferredScopes('0.15.0', true);
    const catalog = new CatalogService(scopes, POLL);
    const a = catalog.search('a');
    await flush();
    resolveNext(rows(0, 3))();
    await a;
    settleLoader({ ok: false, kind: 'error', code: 'failure', exitCode: 1, message: 'boom' });
    await flush();
    const b = catalog.search('b');
    await flush();
    resolveNext(rows(0, 3))();
    await b;
    assert.strictEqual(loaderArgv.length, 2);
    settleLoader();
  });

  test('the loader runs with a long deadline and its stderr reaches the list', async () => {
    const calls: unknown[][] = [];
    const { scopes, resolveNext, settleLoader } = deferredScopes('0.15.0', true);
    const original = scopes.run.bind(scopes);
    scopes.run = ((...args: Parameters<typeof original>) => {
      calls.push(args);
      return original(...args);
    }) as typeof scopes.run;
    const catalog = new CatalogService(scopes, POLL);
    const search = catalog.search('a');
    await flush();
    resolveNext(rows(0, 3))();
    await search;
    assert.ok((calls[0]?.[3] as number) > 120_000, 'longer than the default deadline');
    settleLoader({ ok: true, value: { items: [] }, warnings: 'source down' });
    await flush();
    const again = catalog.search('b');
    await flush();
    resolveNext(rows(0, 3))();
    assert.deepStrictEqual((await again).warnings, 'source down');
  });
});

suite('catalog reloads', () => {
  async function loadedList(total: number) {
    const stub = deferredScopes('0.15.0');
    const catalog = new CatalogService(stub.scopes);
    const first = catalog.search('q');
    await flush();
    serve(stub, total);
    await first;
    while (catalog.hasMore()) {
      const page = catalog.loadNext();
      await flush();
      serve(stub, total);
      await page;
    }
    return { stub, catalog };
  }

  test('a repeat of the search that started a reload keeps that reload', async () => {
    const { stub, catalog } = await loadedList(1_200);
    const first = catalog.search('q');
    await flush();
    serve(stub, 1_450);
    await first;
    const page = catalog.loadNext();
    await flush();
    serve(stub, 1_450);
    await page;
    const loaded = stub.argv.length;
    const repeat = catalog.search('q'); // a watcher refresh while the reload loads
    await flush();
    serve(stub, 1_450);
    await repeat;
    assert.strictEqual(stub.argv.length, loaded + 1, 'one page-one read, no restart');
    const next = catalog.loadNext();
    await flush();
    const args = stub.argv[stub.argv.length - 1] ?? [];
    assert.strictEqual(args[args.indexOf('--offset') + 1], '1200', 'the reload carries on');
    serve(stub, 1_450);
    await next;
  });

  test('a reload that replaces the list drops the rows the old one held', async () => {
    const { stub, catalog } = await loadedList(1_200);
    assert.ok(catalog.row('reg/r1100'));
    const again = catalog.search('q');
    await flush();
    serve(stub, 100);
    await again;
    assert.strictEqual(catalog.row('reg/r1100'), null);
    assert.ok(catalog.row('reg/r50'));
  });

  test('promoting a reload forgets the rows only the old list held', async () => {
    const { stub, catalog } = await loadedList(1_200);
    const reload = catalog.search('q');
    await flush();
    // 1,450 rows now, but without the first row the old list had.
    const args = stub.argv[stub.argv.length - 1] ?? [];
    const take = Number(args[args.indexOf('--limit') + 1]);
    stub.resolveNext(rows(1, take), { total: 1_450 })();
    await reload;
    while (catalog.hasMore()) {
      const page = catalog.loadNext();
      await flush();
      const a = stub.argv[stub.argv.length - 1] ?? [];
      const offset = Number(a[a.indexOf('--offset') + 1]);
      const limit = Number(a[a.indexOf('--limit') + 1]);
      stub.resolveNext(rows(offset + 1, Math.min(limit, 1_450 - offset)), { total: 1_450 })();
      await page;
    }
    assert.strictEqual(catalog.row('reg/r0'), null, 'only the old list held it');
    assert.ok(catalog.row('reg/r1'));
  });
});

suite('catalog output overflow', () => {
  const overflow = 'grim output exceeded 128 MiB';

  test('the unpaged path points at the grim release that pages', async () => {
    const { scopes, failNext } = deferredScopes('0.14.3');
    const catalog = new CatalogService(scopes);
    const search = catalog.search('');
    await flush();
    failNext(overflow, true)();
    const state = await search;
    assert.ok(state.error?.startsWith(overflow));
    assert.match(state.error ?? '', /grim 0\.15\.0 or newer loads search results a page at a time/);
  });

  test('a paged grim leaves the message alone', async () => {
    const { scopes, failNext } = deferredScopes('0.15.0');
    const catalog = new CatalogService(scopes);
    const search = catalog.search('');
    await flush();
    failNext(overflow, true)();
    assert.strictEqual((await search).error, overflow);
  });

  test('an unreadable grim version never gets the update hint', async () => {
    const { scopes, failNext } = deferredScopes(null);
    const catalog = new CatalogService(scopes);
    const search = catalog.search('');
    await flush();
    failNext(overflow, true)();
    assert.strictEqual((await search).error, overflow);
  });

  test('an ordinary error never gets the hint', async () => {
    const { scopes, failNext } = deferredScopes('0.14.3');
    const catalog = new CatalogService(scopes);
    const search = catalog.search('');
    await flush();
    failNext('boom')();
    assert.strictEqual((await search).error, 'boom');
  });
});
