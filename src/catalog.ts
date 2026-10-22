// In-memory search cache. grim itself caches the catalog on disk (1h TTL);
// this layer remembers the last successful result set and when it was fetched,
// for the "Cached catalog · synced Nm ago" footer, and pages a large Browse
// out of that disk catalog while one background grim run (the loader) builds it.
import {
  incompleteSources,
  searchArgs,
  type GrimResult,
  type SearchEnvelope,
  type SearchItem,
  type SearchSortFlag,
} from './grim';
import { PAGING_GRIM_VERSION, supportsPaging } from './installer';
import { searchScopeFor, type ScopeService } from './scopes';
import {
  BACKGROUND_PAGE_SIZE,
  SEARCH_PAGE_SIZE,
  type PagingState,
  type Scope,
} from './webview/protocol';
import { catalogRowFor, type SortMode } from './webview/model';

export { BACKGROUND_PAGE_SIZE, SEARCH_PAGE_SIZE, type PagingState };

/** How long a list waits for the loader to add rows before it reads again, ms. */
const LOADER_POLL_MS = 1_000;
/** A settled loader is trusted this long; grim's own TTL decides what is stale. */
const LOADER_REUSE_MS = 60_000;
/** The loader's own bound. It outlives any build; this only frees a hung grim. */
export const LOADER_TIMEOUT_MS = 30 * 60_000;

export interface SearchOptions {
  refresh?: boolean;
  projectConfigured?: boolean;
  sort?: SortMode;
  /** Internal: the read that follows a loader. It never starts one, and
   *  `reload` forces the list to be replaced even when its head is unchanged. */
  settled?: true;
  reload?: true;
}

export interface CatalogState {
  items: SearchItem[];
  syncedAt: number | null;
  error?: string;
  grimMissing?: boolean;
  /** A source grim could not read in full, one line each (see
   *  incompleteSources). The results here are therefore missing rows by an
   *  unknown amount, which is a different claim from `error` (no results at
   *  all) and from a clean empty list. Present only when non-empty; only that
   *  is used to mark the list, and the lines go to the output channel. */
  incomplete?: string[];
  /** Absent on the unpaged path (grim before 0.15.0), where `items` is the
   *  whole result. */
  paging?: PagingState;
}

export interface LoadResult {
  /** The list this page was for is gone; nothing was appended. */
  superseded?: true;
  error?: string;
  /** The failed read left the list on screen as it is: a page of a reload the
   *  view is not showing (now dropped), or the re-read that settles a finished
   *  list (given up on, not retried). */
  shadow?: true;
  /** The last page of a reload landed and it replaced the list on screen. */
  swapped?: true;
  /** The state's verdict after this page; see {@link CatalogState.incomplete}. */
  incomplete?: string[];
}

/** The paging facts one envelope adds to a list. */
export interface MergedPage {
  /** The page's rows that were not already in the list. */
  added: SearchItem[];
  nextOffset: number;
  total: number;
  lowerBound: boolean;
  done: boolean;
}

/** The paged list a Browse shows. `items` grows in place as pages land (copying
 *  it per page would be quadratic over a large list); `seen` holds its rowKeys. */
interface Browse {
  token: number;
  query: string;
  sort: SearchSortFlag | undefined;
  scope: Scope;
  /** The request that built this list, replayed once the loader has finished. */
  options: SearchOptions;
  items: SearchItem[];
  seen: Set<string>;
  nextOffset: number;
  total: number;
  lowerBound: boolean;
  done: boolean;
  /** Read while the loader was still changing the disk catalog, so the list may
   *  hold a stale or partial view of it and is read again once the loader ends. */
  unsettled: boolean;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function anySourceCapped(sources: unknown): boolean {
  return (
    Array.isArray(sources) &&
    sources.some(
      (s: unknown) => typeof s === 'object' && s !== null && 'capped' in s && s.capped === true,
    )
  );
}

/** One key per card: the same identity buildCards dedups on (cardKey), so a row
 *  this drops is never a card the webview would have shown twice. */
function rowKey(item: SearchItem): string {
  const { alias, locator } = item.source ?? {};
  if (typeof locator !== 'string' || locator === '') {
    return item.repo;
  }
  return `${typeof alias === 'string' && alias !== '' ? alias : locator}\u0000${item.repo}`;
}

/** Adds one page to the list `seen` describes and re-derives the paging facts.
 *
 *  `nextOffset` counts grim's rows, not ours: it must not move when a duplicate
 *  is dropped, or the next request would skip rows. `truncated` alone never
 *  means "more pages" (grim sets it on every page past the first); it only
 *  proves `total` is a lower bound when a capped listing fits page one whole.
 *  Mutates `seen`. Pure otherwise; exported for tests. */
export function mergePage(
  seen: Set<string>,
  page: SearchItem[],
  offset: number,
  env: SearchEnvelope,
  priorLowerBound = false,
): MergedPage {
  const added: SearchItem[] = [];
  for (const item of page) {
    const key = rowKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      added.push(item);
    }
  }
  const nextOffset = offset + page.length;
  const envTotal = nonNegativeInt(env.total);
  // An empty page short of the claimed total means the list shrank under us.
  const total = page.length === 0 ? nextOffset : Math.max(envTotal ?? nextOffset, nextOffset);
  const lowerBound =
    priorLowerBound ||
    (env.truncated === true &&
      offset === 0 &&
      envTotal !== undefined &&
      page.length === envTotal) ||
    anySourceCapped(env.sources);
  // Ends only when grim has nothing more to give: every page either is empty or
  // advances nextOffset, so the walk terminates without a row ceiling.
  const done = page.length === 0 || nextOffset >= total;
  return { added, nextOffset, total, lowerBound, done };
}

function newBrowse(
  token: number,
  query: string,
  sort: SearchSortFlag | undefined,
  scope: Scope,
  options: SearchOptions,
  page: SearchItem[],
  env: SearchEnvelope,
  unsettled: boolean,
): Browse {
  const seen = new Set<string>();
  const { added, ...facts } = mergePage(seen, page, 0, env);
  return { token, query, sort, scope, options, items: added, seen, unsettled, ...facts };
}

/** Whether `a` and `b` open with the same rows. */
function sameHead(a: SearchItem[], b: SearchItem[]): boolean {
  const n = Math.min(a.length, b.length);
  return JSON.stringify(a.slice(0, n)) === JSON.stringify(b.slice(0, n));
}

/** Resolves when `p` settles or after `ms`, whichever comes first. */
async function settleOr(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

const pageOf = (env: SearchEnvelope): SearchItem[] => (Array.isArray(env.items) ? env.items : []);

/** The `incomplete` key, present only when there is a line to carry. */
const verdictOf = (lines: string[]): { incomplete?: string[] } =>
  lines.length > 0 ? { incomplete: lines } : {};

export class CatalogService {
  /** The whole result on the unpaged path; a paged list lives in {@link browse}. */
  private items: SearchItem[] = [];
  private syncedAt: number | null = null;
  /** Monotonic search generation, so a slow response can't overwrite a newer
   *  one's results. Same pattern as SidebarProvider.refreshGen — but that one
   *  only gates POSTING to its own webview; this shared cache is what every
   *  view reads, and the one writer (SidebarProvider.doRefresh) searches on
   *  every keystroke, watcher event and command refresh with no ordering
   *  guard at all. */
  private generation = 0;

  /** The in-flight {@link warm} search, so concurrent callers share one spawn. */
  private warming: Promise<unknown> | null = null;

  /** The paged list the view shows; null on the unpaged path. */
  private browse: Browse | null = null;
  /** A reload of {@link browse} that is loading in the background; it replaces
   *  it when its last page lands, so the list on screen never shrinks to page
   *  one while it reloads. */
  private next: Browse | null = null;
  /** Latest row per repo and source from every page and lookup, so a view can
   *  look up a row the loaded pages do not hold. Per source because several
   *  sources can serve one repo and each observes its own signals (see
   *  catalogRowFor). Bounded by the catalog: every page of the list feeds it. */
  private readonly known = new Map<string, Map<string, SearchItem>>();
  private readonly lookups = new Map<string, Promise<SearchItem | null>>();
  /** The in-flight page and the list it belongs to, so a caller on a newer list
   *  cannot be handed the old list's promise (which resolves superseded). */
  private loading: { list: Browse; pending: Promise<LoadResult> } | null = null;
  /** The online `grim search` per scope that builds or refreshes grim's disk
   *  catalog. It is the only run that may wait on a registry, so it carries no
   *  page and a long deadline; every page is read from disk meanwhile. */
  private readonly loaders = new Map<Scope, Promise<GrimResult<SearchEnvelope>>>();
  /** When each scope's last loader settled, and what it said. */
  private readonly loaderLast = new Map<
    Scope,
    { at: number; error?: string; incomplete?: string[] }
  >();

  constructor(
    private readonly scopes: ScopeService,
    private readonly pollMs = LOADER_POLL_MS,
  ) {}

  state(): CatalogState {
    const b = this.browse;
    return {
      items: b ? b.items.slice() : this.items,
      syncedAt: this.syncedAt,
      ...(b ? { paging: this.pagingFor(b) } : {}),
    };
  }

  /** Where the live list stands; undefined on the unpaged path. */
  paging(): PagingState | undefined {
    return this.browse ? this.pagingFor(this.browse) : undefined;
  }

  /** The live list's rows from `index` on, for the host to post what the
   *  webview does not hold yet. */
  rowsFrom(index: number): SearchItem[] {
    return this.browse ? this.browse.items.slice(index) : [];
  }

  /** True while the live list has pages left to load or is still waiting on the
   *  loader. */
  hasMore(): boolean {
    const b = this.next ?? this.browse;
    return b !== null && this.more(b);
  }

  /** Rows remain on disk, or the disk catalog may still change under the list. */
  private more(b: Browse): boolean {
    return !b.done || b.unsettled || this.loaders.has(b.scope);
  }

  private pagingFor(b: Browse): PagingState {
    return {
      token: b.token,
      loaded: b.items.length,
      // A catalog still being built only has a lower bound to count.
      total: b.total,
      lowerBound: b.lowerBound || this.loaders.has(b.scope),
      hasMore: this.more(b),
      ...(b.sort ? { sort: b.sort } : {}),
    };
  }

  /** The latest row seen for `repo`, its sources merged, or null. */
  row(repo: string): SearchItem | null {
    const rows = this.known.get(repo);
    // The same `as never` bridge between SearchItem and WireSearchItem the
    // details panel used for this call; the two are structurally one shape.
    return rows ? (catalogRowFor(repo, [...rows.values()] as never) as SearchItem | null) : null;
  }

  /** True once a lookup for `repo` has been started or settled this session. */
  looked(repo: string): boolean {
    return this.lookups.has(repo);
  }

  /** Every repo's latest row seen this session, not only the loaded page(s). */
  knownItems(): SearchItem[] {
    return [...this.known.values()].flatMap((rows) => [...rows.values()]);
  }

  /** Runs the first search of the session if none has landed yet.
   *
   *  The sidebar is this cache's only regular writer, and it searches only once
   *  it is VISIBLE — so a details panel restored at boot with the sidebar
   *  collapsed read an empty cache, and its catalog-only signals (the rating,
   *  the pull count) stayed blank until a sidebar refresh happened to fill it.
   *  Cheap: grim answers an un-refreshed search from its own disk catalog. */
  async warm(projectConfigured: boolean): Promise<void> {
    if (this.syncedAt !== null) {
      return;
    }
    this.warming ??= this.search('', { projectConfigured }).finally(() => {
      this.warming = null;
    });
    await this.warming;
  }

  async search(query: string, options: SearchOptions = {}): Promise<CatalogState> {
    // The generation is taken before the first await so "the last search to
    // START owns the cache" still holds while the version is being read.
    const generation = ++this.generation;
    const version = await this.scopes.grimVersion();
    const paged = supportsPaging(version ?? '');
    const sort =
      options.sort === undefined || options.sort === 'relevance' ? undefined : options.sort;
    // grim's own `options.show_deprecated` config (set via the Settings panel,
    // which replaced the old grimoire.showDeprecated VS Code setting) drives
    // deprecation visibility — the flag is omitted so `grim search` honors
    // whatever the user has configured, no VS Code-side override.
    //
    // Browse is discovery, not project state: an open folder searches project
    // scope ONLY when it has a grimoire.toml. Without one, project-scope search
    // has no registries and returns []; fall back to global so the global
    // registries' catalog is still browsable (and installable globally).
    // Callers pass projectConfigured via scopes.projectSearchable(), which also
    // treats a FAILED project probe as "configured" — otherwise a transient
    // probe error would silently fall back to global too, instead of searching
    // project scope and surfacing the failure as a search error. The rule
    // itself lives in searchScopeFor, so the Settings panel's "Browse searches
    // <scope>" notice cannot drift from where Browse actually looks.
    const scope = searchScopeFor(this.scopes.projectFolder(), options.projectConfigured === true);
    let args: string[];
    if (paged) {
      // Pages are read from disk (`--offline`): an online page that finds the
      // catalog stale would itself become the build and block here for all of
      // it. The loader does that build, and later pages load in the background.
      if (options.settled !== true) {
        this.ensureLoader(scope, options.refresh === true);
      }
      args = searchArgs(query, {
        offline: true,
        ...(sort ? { sort } : {}),
        offset: 0,
        limit: SEARCH_PAGE_SIZE,
      });
    } else {
      // grim-polyfill<0.15.0: grim before 0.15.0 rejects search --limit/--offset (clap exit 64); fetch the whole catalog unpaged
      args = searchArgs(query, options.refresh ? { refresh: true } : {});
    }
    let result: GrimResult<SearchEnvelope> = await this.scopes.run(args, scope);
    // A cold catalog reads empty until the loader's first checkpoint, and an
    // empty read is not an empty registry while the loader runs: wait for rows.
    // Only the unfiltered list can say so; a query that matches nothing cannot,
    // and its rows reach the list as the walker reads on.
    const everything = query.trim() === '';
    while (paged && everything && result.ok && generation === this.generation) {
      const loader = this.loaders.get(scope);
      if (!loader || pageOf(result.value).length > 0) {
        break;
      }
      await settleOr(loader, this.pollMs);
      result = await this.scopes.run(args, scope);
    }
    if (!result.ok) {
      if (result.kind === 'not-found') {
        return { items: [], syncedAt: this.syncedAt, grimMissing: true };
      }
      // grim-polyfill<0.15.0: grim before 0.15.0 cannot page, so an output overflow has no remedy but a newer grim
      const hint =
        !paged && result.overflow && version !== undefined
          ? `. grim ${PAGING_GRIM_VERSION} or newer loads search results a page at a time; update grim to browse large indexes.`
          : '';
      return { items: this.items, syncedAt: this.syncedAt, error: result.message + hint };
    }
    // Boundary guard: an envelope that parses ok but whose `items` is missing
    // or not an array (contract violation, but observed from misbehaving stubs
    // and possible on a version-skewed grim) must not poison the cache — the
    // card builders iterate it.
    const page = pageOf(result.value);
    const loaded = paged ? this.loaderLast.get(scope) : undefined;
    if (
      paged &&
      everything &&
      page.length === 0 &&
      loaded?.error !== undefined &&
      !this.loaders.has(scope)
    ) {
      // The loader failed and left nothing to show: that is the search's error.
      return { items: this.items, syncedAt: this.syncedAt, error: loaded.error };
    }
    const incomplete = verdictOf(
      paged
        ? this.pagedVerdict(scope, result.value, result.warnings)
        : incompleteSources(result.value, result.warnings),
    );
    const unsettled = paged && (this.loaders.has(scope) || options.refresh === true);
    const fresh = paged
      ? newBrowse(generation, query, sort, scope, options, page, result.value, unsettled)
      : null;
    if (generation !== this.generation) {
      // A newer search started while this one was in flight and its results
      // are what the cache should hold. Return this caller's own results —
      // they are real, just superseded — without clobbering the cache. Its
      // paging carries its own token, which no live list matches.
      return {
        items: fresh ? fresh.items : page,
        syncedAt: this.syncedAt,
        ...(fresh ? { paging: this.pagingFor(fresh) } : {}),
        ...incomplete,
      };
    }
    this.items = fresh ? [] : page;
    if (fresh) {
      this.adopt(fresh, options.reload === true);
    } else {
      this.next = null;
      this.browse = null;
      if (options.refresh) {
        this.forget();
      }
    }
    this.feed(page);
    this.syncedAt = Date.now();
    return { ...this.state(), ...incomplete };
  }

  /** What a paged read says is incomplete: its own sources (capped ignored while
   *  the loader builds, when the disk it read is a checkpoint) joined with the
   *  scope's last loader, whose verdict stands for the disk catalog until the
   *  next one settles — an `--offline` read after a failed refresh reports the
   *  dead source ok, so only the loader knows. */
  private pagedVerdict(scope: Scope, env: SearchEnvelope, warnings: string | undefined): string[] {
    const own = incompleteSources(env, warnings, { ignoreCapped: this.loaders.has(scope) });
    return [...new Set([...own, ...(this.loaderLast.get(scope)?.incomplete ?? [])])];
  }

  /** Starts the scope's loader unless one runs or a recent one succeeded; grim's
   *  own TTL decides whether there is anything to rebuild. An explicit refresh
   *  always asks. */
  private ensureLoader(scope: Scope, refresh: boolean): void {
    const last = this.loaderLast.get(scope);
    const recent =
      last !== undefined && last.error === undefined && Date.now() - last.at < LOADER_REUSE_MS;
    if (this.loaders.has(scope) || (recent && !refresh)) {
      return;
    }
    const run = this.scopes
      .run<SearchEnvelope>(
        searchArgs('', { ...(refresh ? { refresh: true } : {}), limit: 1 }),
        scope,
        undefined,
        LOADER_TIMEOUT_MS,
      )
      .then((result) => {
        this.loaders.delete(scope);
        this.loaderLast.set(scope, {
          at: Date.now(),
          ...(!result.ok
            ? { error: result.kind === 'error' ? result.message : 'grim not found' }
            : verdictOf(incompleteSources(result.value, result.warnings))),
        });
        return result;
      });
    this.loaders.set(scope, run);
  }

  /** Decides what a fresh first page does to the list already on screen.
   *
   *  The same query, sort and scope with an unchanged head and total keeps the
   *  loaded list as it is (unless `force`, an explicit refresh). Otherwise a
   *  longer list keeps showing while the new one loads behind it (`next`), and
   *  anything else is simply replaced. */
  private adopt(fresh: Browse, force: boolean): void {
    const prev = this.browse;
    const same =
      prev !== null &&
      prev.query === fresh.query &&
      prev.sort === fresh.sort &&
      prev.scope === fresh.scope;
    if (!same) {
      this.next = null;
      this.browse = fresh;
      if (force) {
        this.forget();
      }
      return;
    }
    const shadow = this.next;
    if (!force && shadow && shadow.total === fresh.total && sameHead(shadow.items, fresh.items)) {
      return; // the reload under way is this one; restarting it would only lose its pages
    }
    this.next = null;
    const longer = prev.items.length > fresh.items.length;
    if (!force && longer && prev.total === fresh.total && sameHead(prev.items, fresh.items)) {
      prev.unsettled = fresh.unsettled;
      return;
    }
    if (longer && !fresh.done) {
      this.next = fresh;
      return;
    }
    // Replaced outright. A list that shrank drops rows the source no longer has.
    this.browse = fresh;
    if (force || longer) {
      this.forget();
    }
  }

  /** Appends the next page to the list being loaded: the reload when there is
   *  one, else the list on screen. Later pages run `--offline`: a
   *  cache refresh between pages would reorder rows and skip or repeat some. */
  loadNext(): Promise<LoadResult> {
    const b = this.next ?? this.browse;
    if (!b || !this.more(b)) {
      return Promise.resolve({ superseded: true });
    }
    if (this.loading?.list === b) {
      return this.loading.pending;
    }
    const entry = {
      list: b,
      pending: this.fetchNextPage(b).finally(() => {
        if (this.loading === entry) {
          this.loading = null;
        }
      }),
    };
    this.loading = entry;
    return entry.pending;
  }

  private async fetchNextPage(b: Browse): Promise<LoadResult> {
    if (b.done) {
      // Every row on disk is loaded. While the loader runs it may add more, so
      // wait a beat and look again; once it ends, read the list afresh.
      const loader = this.loaders.get(b.scope);
      if (loader) {
        b.unsettled = true;
        await settleOr(loader, this.pollMs);
        if (this.browse !== b && this.next !== b) {
          return { superseded: true };
        }
      }
      if (!this.loaders.has(b.scope)) {
        return b.unsettled ? this.reconcile(b) : {};
      }
    }
    b.unsettled ||= this.loaders.has(b.scope);
    const args = searchArgs(b.query, {
      offline: true,
      ...(b.sort ? { sort: b.sort } : {}),
      offset: b.nextOffset,
      limit: BACKGROUND_PAGE_SIZE,
    });
    const result: GrimResult<SearchEnvelope> = await this.scopes.run(args, b.scope);
    // A newer search replaced this list while the page was in flight; a page of
    // the old query must never land on the new one.
    if (this.browse !== b && this.next !== b) {
      return { superseded: true };
    }
    if (!result.ok) {
      const error = result.kind === 'error' ? result.message : 'grim not found';
      if (this.next === b) {
        this.next = null;
        return { error, shadow: true };
      }
      return { error };
    }
    const page = pageOf(result.value);
    const m = mergePage(b.seen, page, b.nextOffset, result.value, b.lowerBound);
    b.items.push(...m.added);
    b.nextOffset = m.nextOffset;
    b.total = m.total;
    b.lowerBound = m.lowerBound;
    b.done = m.done;
    this.feed(page);
    const incomplete = verdictOf(this.pagedVerdict(b.scope, result.value, result.warnings));
    if (this.next === b && b.done) {
      // The reload's rows are the catalog now: what remembered rows and lookups
      // held of the list it replaces must not outlive it.
      this.browse = b;
      this.next = null;
      this.forget();
      this.feed(b.items);
      return { swapped: true, ...incomplete };
    }
    return incomplete;
  }

  /** Reads the list again once the loader has ended: rows it added may sit
   *  before the offset already loaded, which paging forward would skip. The
   *  read replaces the list, or reloads behind it, exactly as a repeat search. */
  private async reconcile(b: Browse): Promise<LoadResult> {
    const { projectConfigured, sort, refresh, reload } = b.options;
    const state = await this.search(b.query, {
      ...(projectConfigured !== undefined ? { projectConfigured } : {}),
      ...(sort !== undefined ? { sort } : {}),
      settled: true,
      ...(refresh || reload ? { reload: true as const } : {}),
    });
    if (state.error !== undefined || state.grimMissing === true) {
      // Not retried: nothing changed in `b`, so `hasMore` would stay true and
      // the walker would spawn the failing read again at once, for ever. The
      // list on screen stands; the next search or refresh reads it afresh.
      b.unsettled = false;
      return { error: state.error ?? 'grim not found', shadow: true };
    }
    return state.incomplete !== undefined ? { incomplete: state.incomplete } : {};
  }

  /** Drops every remembered row and lookup. */
  private forget(): void {
    this.known.clear();
    this.lookups.clear();
  }

  /** One exact-repo row, for a repo the loaded pages do not hold (a rating, a
   *  pull count). Costs one local `--offline` spawn per distinct repo per
   *  session. Never spawns on a grim that cannot page. Its stderr goes to
   *  the output channel only, never into the incomplete-results verdict. */
  lookup(repo: string, scope?: Scope): Promise<SearchItem | null> {
    const hit = this.row(repo);
    const where = scope ?? this.browse?.scope;
    if (hit || where === undefined) {
      return Promise.resolve(hit);
    }
    let pending = this.lookups.get(repo);
    if (!pending) {
      pending = this.fetchRow(repo, where);
      this.lookups.set(repo, pending);
    }
    return pending;
  }

  private async fetchRow(repo: string, scope: Scope): Promise<SearchItem | null> {
    // A list on screen means a paging grim; with none yet (a details panel
    // opened first) the version decides. A grim that cannot page holds every
    // row already and rejects --limit.
    if (!this.browse && !supportsPaging((await this.scopes.grimVersion()) ?? '')) {
      this.lookups.delete(repo);
      return null;
    }
    const result: GrimResult<SearchEnvelope> = await this.scopes.run(
      searchArgs(repo, { offline: true, limit: 10 }),
      scope,
    );
    if (!result.ok || !Array.isArray(result.value.items)) {
      // Not memoized: a transient failure must not pin the repo to "no row".
      this.lookups.delete(repo);
      return null;
    }
    // The full-reference match is fuzzy, so only the exact repo is kept.
    this.feed(result.value.items.filter((i) => i.repo === repo));
    return this.row(repo);
  }

  private feed(items: SearchItem[]): void {
    for (const item of items) {
      const rows = this.known.get(item.repo) ?? new Map<string, SearchItem>();
      rows.set(item.source?.locator ?? '', item);
      this.known.set(item.repo, rows);
    }
  }
}
