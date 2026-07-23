// CatalogService's shared result cache. Every view reads it, and several
// triggers can search concurrently (the search box, watcher/command refreshes,
// the details panels), so response ordering is the thing worth pinning down.
import * as assert from 'assert';
import { CatalogService } from '../catalog';
import type { GrimResult, ItemsEnvelope, SearchItem } from '../grim';
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

/** A ScopeService stand-in whose `run` resolves when the test says so. Each
 *  in-flight search carries its OWN items, so a test can settle them in any
 *  order without the results depending on the order the settlers were built. */
function deferredScopes(): {
  scopes: ScopeService;
  resolveNext: (items: SearchItem[]) => () => void;
} {
  const pending: ((items: SearchItem[]) => void)[] = [];
  const scopes = {
    projectFolder: () => undefined,
    run: <T>(): Promise<GrimResult<T>> =>
      new Promise((resolve) => {
        pending.push((items) => {
          const result: GrimResult<ItemsEnvelope<SearchItem>> = { ok: true, value: { items } };
          resolve(result as GrimResult<T>);
        });
      }),
  } as unknown as ScopeService;
  return {
    scopes,
    resolveNext: (items) => {
      const settle = pending.shift();
      assert.ok(settle, 'no search was in flight');
      return () => settle(items);
    },
  };
}

suite('catalog search ordering', () => {
  test('a superseded response never overwrites the newer search results', async () => {
    const { scopes, resolveNext } = deferredScopes();
    const catalog = new CatalogService(scopes);

    const older = catalog.search('a');
    const newer = catalog.search('b');
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
