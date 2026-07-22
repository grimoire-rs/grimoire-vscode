// CatalogService's shared result cache. Every view reads it, and several
// triggers can search concurrently (the search box, watcher/command refreshes,
// the details panels), so response ordering is the thing worth pinning down.
import * as assert from 'assert';
import { CatalogService } from '../catalog';
import type { GrimResult, ItemsEnvelope, SearchItem } from '../grim';
import type { ScopeService } from '../scopes';

function searchItem(repo: string): SearchItem {
  return {
    repo,
    kind: 'skill',
    name: repo.split('/').pop() ?? repo,
    summary: null,
    description: null,
    version: null,
    latest_tag: null,
    deprecated: null,
    replaced_by: null,
  } as unknown as SearchItem;
}

/** A ScopeService stand-in whose `run` resolves when the test says so. */
function deferredScopes(): {
  scopes: ScopeService;
  resolveNext: (items: SearchItem[]) => () => void;
} {
  const pending: (() => void)[] = [];
  const scopes = {
    projectFolder: () => undefined,
    run: <T>(): Promise<GrimResult<T>> =>
      new Promise((resolve) => {
        pending.push(() => resolve(nextResult as GrimResult<T>));
      }),
  } as unknown as ScopeService;
  let nextResult: GrimResult<ItemsEnvelope<SearchItem>>;
  return {
    scopes,
    resolveNext: (items) => {
      const settle = pending.shift();
      assert.ok(settle, 'no search was in flight');
      return () => {
        nextResult = { ok: true, value: { items } } as GrimResult<ItemsEnvelope<SearchItem>>;
        settle();
      };
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
    const settleOlder = resolveNext([searchItem('reg/old')]);
    const settleNewer = resolveNext([searchItem('reg/new')]);
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
    const settleOlder = resolveNext([searchItem('reg/old')]);
    const settleNewer = resolveNext([searchItem('reg/new')]);
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
