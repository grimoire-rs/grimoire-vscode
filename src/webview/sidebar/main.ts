// Sidebar webview entry: dumb event wiring over the pure lit renderers.
import '../monogram.css';
import './sidebar.css';
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import '@vscode-elements/elements/dist/vscode-badge/index.js';
import '@vscode-elements/elements/dist/vscode-progress-bar/index.js';
import '@vscode-elements/elements/dist/vscode-icon/index.js';
import '@vscode-elements/elements/dist/vscode-scrollable/index.js';
import { render as litRender, type TemplateResult } from 'lit-html';
import { isMutating } from '../actions';
import { armBrokenImages } from '../brokenImage';
import type { CardVM, HostToSidebar, SidebarState, SidebarToHost, ViewAction } from '../protocol';
import {
  CardFilter,
  DEFAULT_FILTER,
  DEFAULT_INSTALLED_FILTER,
  DEFAULT_VIEW,
  NATURAL,
  browseSortRequest,
  buildTree,
  collectNodeIds,
  cycleGroup,
  defaultScope,
  filterCards,
  foldHostPost,
  footerTickRenders,
  groupCards,
  groupKeyFor,
  installedCards,
  keepPaintedOnLoading,
  measuredHeights,
  navTarget,
  resultIsPartial,
  revealScrollTop,
  rowIndexByKey,
  rowOffset,
  toggleKinds,
  topLevelIds,
  treeKeyAction,
  viewForTab,
  viewportReport,
  windowRows,
  type FlatRow,
  type GroupContext,
  type SidebarTab,
  type StagedPosts,
  type SortMode,
  type ViewOptions,
} from '../model';
import {
  prepareResults,
  renderCard,
  renderCardContextMenu,
  renderCardMenu,
  renderRefreshingFooter,
  renderSidebarFilters,
  renderSidebarFooter,
  renderSidebarNotice,
  renderSidebarResults,
  renderSidebarSearch,
  renderSidebarTabs,
  type PreparedResults,
} from '../render';

interface PersistedState {
  tab?: SidebarTab;
  /** Browse tab's filter (the pre-merge single `filter` key, so an old
   *  persisted shape restores into the Browse tab). */
  filter?: CardFilter;
  installedFilter?: CardFilter;
  installedQuery?: string;
  query?: string;
  /** Row density, flat-vs-tree and the grouping keys. Absent on a first run and
   *  on any state written before view modes existed — DEFAULT_VIEW fills in. */
  view?: ViewOptions;
  /** Expanded group-header / tree-node ids (a Set at runtime; an array here
   *  because setState round-trips through structured JSON). */
  expanded?: string[];
}

declare function acquireVsCodeApi(): {
  postMessage(message: SidebarToHost): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;
// Card and row logos are data: URIs built from companion bytes — a truncated or
// mistyped asset decodes to nothing and would paint the browser's own glyph.
armBrokenImages(root);
// Item 3: six independently-updatable regions, each its own lit render root.
// A search-result state update re-renders only the results (and the filters,
// when their content differs) and never destroys the textfield the user is
// typing into — lit's own reconciliation keeps #search's DOM identity across
// renders, which is what makes the old shape-signature rebuild gating and its
// manual focus/caret save-restore unnecessary now (see deleteList). Built as
// real nodes (no string HTML in the webview) — a one-time empty scaffold.
function region(id: string): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  root.appendChild(el);
  return el;
}
const noticeEl = region('sb-notice');
const tabsEl = region('sb-tabs');
const searchEl = region('sb-search');
const filtersEl = region('sb-filters');
// Results scroll inside vscode-scrollable — the workbench's own overlay
// scrollbar (hover-visible thumb on the scrollbarSlider tokens, transparent
// track, top scroll-shadow), the same look as the native marketplace list.
// A raw overflow container can't get there: the webview default stylesheet
// sets html { scrollbar-color: <slider> <EDITOR-background> }, which paints
// the track with the wrong surface color in the sidebar AND — scrollbar-color
// being set and inherited — makes Chromium ignore ::-webkit-scrollbar rules.
const scrollEl = document.createElement('vscode-scrollable');
scrollEl.id = 'sb-scroll';
root.appendChild(scrollEl);
const resultsEl = document.createElement('div');
resultsEl.id = 'sb-results';
scrollEl.appendChild(resultsEl);
const footerEl = region('sb-footer');

const saved = vscode.getState();
let state: SidebarState | null = null;
// The active internal tab plus per-tab client state: Browse and Installed keep
// independent filters, and Installed's name query is client-side only (Browse's
// round-trips to the host, which feeds it to catalog.search).
let activeTab: SidebarTab =
  saved?.tab === 'updates' || saved?.tab === 'installed' ? saved.tab : 'browse';
const filters: { browse: CardFilter; installed: CardFilter } = {
  browse: { ...DEFAULT_FILTER, ...(saved?.filter ?? {}) },
  installed: { ...DEFAULT_INSTALLED_FILTER, ...(saved?.installedFilter ?? {}) },
};
let installedQuery = saved?.installedQuery ?? '';
// View modes are per-webview UI state, persisted the same way the tab and the
// kind chips already are — not a setting: nobody edits this in settings.json,
// and it is per view, not per machine.
const viewOptions: ViewOptions = { ...DEFAULT_VIEW, ...(saved?.view ?? {}) };
const expanded = new Set<string>(saved?.expanded ?? []);
// Whether the first state post has already had its chance to open the top
// level (see the `state` handler). Once per webview, not once per refresh.
let seeded = false;
let searchDebounce: ReturnType<typeof setTimeout> | undefined;
// A reload over painted content doesn't show "Refreshing…" immediately — only
// once it's taken more than a second (a quick refresh would otherwise flicker
// the status line). Cleared whenever a ready/error state lands first.
let loadingFooterTimeout: ReturnType<typeof setTimeout> | undefined;
// True from a kept-painted loading state until the next ready/error state.
let refreshInFlight = false;
// A focusSearch that arrived before anything was painted. The sidebar has no
// first-paint body — render() bails while `state` is null — so `#search` does
// not exist yet when a post held across the boot handshake is drained, and
// focusing it was a silent no-op that flipped the tab and did nothing else.
// Honoured at the end of the next render().
let focusPending = false;
// Every clickable artifact row, whichever density/mode rendered it. Card and
// compact row both carry `data-repo`, so open-details, the double-click promote
// and the right-click menu work off one selector instead of three copies of
// '.card' that only the comfortable list would have matched.
const ROW_SELECTOR = '.card, .compact-row';
// Gear/right-click menus are appended onto root, fixed-positioned — never
// inside the card: the results live in vscode-scrollable's viewport, which
// clips any absolutely-positioned child at the widget border. The anchor is
// the actual clicked element so an artifact installed in both scopes — two
// cards, same data-repo — resolves unambiguously (toggle closes the right one).
let cardMenuEl: HTMLElement | null = null;
let cardMenuAnchor: HTMLElement | null = null;
let contextMenuEl: HTMLElement | null = null;

function closeContextMenu(): void {
  contextMenuEl?.remove();
  contextMenuEl = null;
}

function closeCardMenu(): void {
  cardMenuEl?.remove();
  cardMenuEl = null;
  cardMenuAnchor = null;
}

/** Keeps a fixed-positioned menu fully inside the webview viewport. */
function clampMenuToViewport(menu: HTMLElement): void {
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
  }
}

function persist(): void {
  vscode.setState({
    tab: activeTab,
    filter: filters.browse,
    installedFilter: filters.installed,
    installedQuery,
    query: state?.query ?? '',
    view: viewOptions,
    expanded: [...expanded],
  });
}

/** The cards the active tab is currently showing — the same derivation
 *  render.ts runs, so the node ids computed off it are the ones on screen. */
function visibleCards(): CardVM[] {
  if (!state) {
    return [];
  }
  const tabView = viewForTab(state, activeTab, installedQuery);
  return activeTab === 'installed'
    ? installedCards(tabView, activeFilter())
    : filterCards(tabView.items, shownFilter());
}

/** Group-header / tree-node ids currently in play, outermost first. */
function currentNodeIds(): string[] {
  if (!state || activeTab === 'updates') {
    return [];
  }
  const context: GroupContext = {
    registries: state.registries,
    projectName: state.scopes.projectName,
  };
  if (viewOptions.mode === 'tree') {
    return collectNodeIds(buildTree(visibleCards(), context));
  }
  const key = groupKeyFor(activeTab, viewOptions);
  return key === 'none' ? [] : groupCards(visibleCards(), key, context).map((g) => g.id);
}

/** Opens the top level when a newly-entered tree/grouping has nothing expanded
 *  yet — an all-collapsed first paint reads as an empty view. A set the user
 *  has already touched here is left alone. */
function seedExpanded(): void {
  if (!state || activeTab === 'updates') {
    return;
  }
  const context: GroupContext = {
    registries: state.registries,
    projectName: state.scopes.projectName,
  };
  const top =
    viewOptions.mode === 'tree'
      ? topLevelIds(buildTree(visibleCards(), context))
      : currentNodeIds().slice(0, 1);
  if (top.some((id) => expanded.has(id))) {
    return;
  }
  for (const id of top) {
    expanded.add(id);
  }
}

/** The active tab's filter. Updates has no filter UI, so it falls through to
 *  BROWSE's — not to a fresh default. Nothing on that tab may narrow its list by
 *  it (render.ts's updates branch deliberately ignores the filter it is handed):
 *  Browse's chips persist across reloads, and a chip set there was hiding rows
 *  the tab pill and the activity-bar badge went on counting. */
function activeFilter(): CardFilter {
  return activeTab === 'installed' ? filters.installed : filters.browse;
}

/** The filter the list is actually ordered by: Browse's direction is pinned to
 *  the field's natural one while pages remain (see browseSortRequest). */
function shownFilter(): CardFilter {
  const filter = activeFilter();
  return activeTab === 'browse'
    ? { ...filter, dir: browseSortRequest(filter, state?.paging).dir }
    : filter;
}

function setActiveFilter(next: CardFilter): void {
  if (activeTab === 'installed') {
    filters.installed = next;
  } else {
    filters.browse = next;
  }
}

function cardByRepo(repo: string): CardVM | undefined {
  // Menus open from any tab; browse and installed card lists both resolve.
  return (
    state?.items.find((c) => c.repo === repo) ?? state?.installedItems.find((c) => c.repo === repo)
  );
}

// Menus render into a one-shot detached container — never re-rendered, so it's
// safe to lift the resulting element straight out of it (no string HTML
// anywhere: this is lit's own render(), not insertAdjacentHTML).
function renderToElement(tpl: TemplateResult): HTMLElement {
  const host = document.createElement('div');
  litRender(tpl, host);
  return host.firstElementChild as HTMLElement;
}

function render(): void {
  if (!state) {
    return;
  }
  // A state-driven re-render drops any open menus. This is NOT optional: both
  // menus are appended onto #root, outside the regions lit owns, and lit gives
  // no free wipe-on-rerender the way the old wholesale innerHTML replace did —
  // an un-closed menu could survive next to lit's own children, or be ripped
  // out unpredictably by lit's list reconciliation.
  closeCardMenu();
  closeContextMenu();

  const view = viewForTab(state, activeTab, installedQuery);
  litRender(renderSidebarNotice(view), noticeEl);
  litRender(renderSidebarTabs(view), tabsEl);
  syncSearchValue(view);
  litRender(renderSidebarFilters(view, activeFilter()), filtersEl);
  renderResults();
  litRender(renderSidebarFooter(view), footerEl);
  if (focusPending) {
    focusPending = false;
    (document.getElementById('search') as HTMLInputElement | null)?.focus();
  }
}

/** The results region alone: render() calls it, and so does a Browse post that
 *  needs no full render (an appended page or a replacing state) and the
 *  Installed name filter. Unlike render() it leaves an open card menu in place.
 *  Re-derives the rows, so every data, view or filter change comes through
 *  here; a scroll does not. */
function renderResults(): void {
  if (!state) {
    return;
  }
  const view = viewForTab(state, activeTab, installedQuery);
  // Heights are per row key, but a key means a different template (and so a
  // different height) under another tab, density, mode or grouping.
  const layout = `${activeTab}:${JSON.stringify(viewOptions)}`;
  if (layout !== heightsLayout) {
    heightsLayout = layout;
    rowHeights.clear();
  }
  const prepared = prepareResults(view, activeFilter(), viewOptions, expanded);
  results = { tab: view, prepared, index: rowIndexByKey(prepared.rows) };
  measureScroll();
  paintResults();
}

// Renders the search region on every render() (lit's own dirty-check makes an
// unchanged value a no-op — no more shape-signature gating). The one thing
// lit's template binding can't know on its own: `vscode-textfield` is a custom
// element with an attribute *and* a live edited-value property, and a stale or
// differing query fed in while the field is focused (a debounced echo race, a
// query seeded from elsewhere) would otherwise stomp an in-progress keystroke
// and caret. While focused, render with the box's OWN current value instead of
// state.query — the binding then either no-ops or writes back the identical
// string, so typing is never disturbed; the clear-icon visibility (computed
// from the same query inside the template) follows the live value too.
function syncSearchValue(view: SidebarState | null = null): void {
  const toSync = view ?? (state ? viewForTab(state, activeTab, installedQuery) : null);
  if (!toSync) {
    return;
  }
  const input = document.getElementById('search') as HTMLInputElement | null;
  const focused = document.activeElement?.id === 'search';
  const toRender = focused && input ? { ...toSync, query: input.value } : toSync;
  litRender(renderSidebarSearch(toRender, activeFilter()), searchEl);
}

function post(message: SidebarToHost): void {
  vscode.postMessage(message);
}

/** A Browse search carries the sort so grim's first page is ordered by it. */
function postSearch(query: string): void {
  post({ type: 'search', query, sort: filters.browse.sort });
}

/** The sort last re-requested from the host, so a host that does not honour it
 *  (a stored sort grim never heard of) cannot turn this into a search loop. */
let requestedSort: SortMode | null = null;

/** While the result is partial (pages still loading, or stopped on a failure),
 *  grim must hold the order the user picked: sorting only the loaded prefix would
 *  rank the first page, not the whole catalog. A complete list sorts
 *  client-side and needs no round trip. */
function syncServerSort(): void {
  const paging = state?.paging;
  if (
    !state ||
    !paging ||
    !resultIsPartial(paging) ||
    activeTab !== 'browse' ||
    state.phase !== 'ready' ||
    state.stale === true ||
    refreshInFlight
  ) {
    return;
  }
  if ((paging.sort ?? 'relevance') === filters.browse.sort) {
    requestedSort = null;
  } else if (requestedSort !== filters.browse.sort) {
    requestedSort = filters.browse.sort;
    postSearch(state.query);
  }
}

// --- Results windowing and viewport reporting ---

// Only the rows near the scroll position are in the DOM (render.ts / model.ts
// windowRows); the rest are spacers sized from the row heights below. The
// rendered window is also what the host's details prefetch follows.
const VISIBLE_DEBOUNCE_MS = 300;
/** Render passes after one paint while measured heights keep moving. Heights
 *  are deterministic per row, so this ends in one or two; the cap only stops a
 *  pathological layout from looping. */
const MAX_PAINT_PASSES = 3;
/** Sub-pixel layout noise below this is not a height change. */
const HEIGHT_EPSILON = 0.5;

/** What the last data change derived; scroll renders reuse it. */
let results: { tab: SidebarState; prepared: PreparedResults; index: Map<string, number> } | null =
  null;
/** Measured row pitch by row key (see measureRows). */
const rowHeights = new Map<string, number>();
let heightsLayout = '';
let focusKey: string | undefined;
// The shadow scroller once it exists; before that the list reads as scrolled to
// the top in a window-high viewport.
let scroller: HTMLElement | null = null;
let listScrollTop = 0;
let viewportPx = window.innerHeight;
let listWidth = -1;
let paintedWindow = { start: -1, end: -1, pin: -1 };
let windowFrame: number | undefined;
let windowForced = false;
let visibleRepos: string[] = [];
let reportedKey: string | null = null;
let visibleTimer: ReturnType<typeof setTimeout> | undefined;

/** Trailing-edge debounce: report the viewport once scrolling SETTLES.
 *
 *  This used to return early while a timer was pending, which is a leading-edge
 *  throttle wearing a debounce's name — the first callback of a burst started
 *  the clock and no later one extended it, so a sustained scroll posted roughly
 *  every 300ms and each post re-entered the host's enqueue with one serialized
 *  cache read per row.
 *
 *  Reading `visibleRepos` inside the timer (not at schedule time) is required,
 *  not incidental: the whole point is to act on the latest state once things
 *  settle. Snapshotting at schedule time would reproduce the bug above. */
function scheduleVisiblePost(): void {
  if (visibleTimer !== undefined) {
    clearTimeout(visibleTimer);
  }
  visibleTimer = setTimeout(() => {
    visibleTimer = undefined;
    // Load-bearing, not a tidy-up: an empty list is "nothing painted", not "nothing
    // visible" — posting it would make the host consume the one-shot force flag
    // an explicit refresh had just armed.
    if (visibleRepos.length > 0) {
      post({ type: 'visible', repos: visibleRepos });
    }
  }, VISIBLE_DEBOUNCE_MS);
}

/** The artifact rows now in the DOM — the window, overscan included — go to the
 *  host when that set changed. ROW_SELECTOR, not '[data-repo]': the latter also
 *  matches the install button nested inside a row. */
function reportVisible(): void {
  const repos = [
    ...new Set(
      [...resultsEl.querySelectorAll<HTMLElement>(ROW_SELECTOR)].flatMap((row) =>
        row.dataset['repo'] ? [row.dataset['repo']] : [],
      ),
    ),
  ];
  const { key, report } = viewportReport(reportedKey, repos, state?.round);
  if (!report) {
    return;
  }
  reportedKey = key;
  visibleRepos = repos;
  scheduleVisiblePost();
}

/** Where the list is scrolled to, relative to its own top: the summary line and
 *  anything above the list scroll too, so the scroller's scrollTop is not it.
 *  Every windowed layout (Browse and Installed) renders inside `.cards`. */
function measureScroll(): void {
  if (!scroller) {
    return;
  }
  viewportPx = scroller.clientHeight;
  const cards = resultsEl.querySelector('.cards');
  listScrollTop = cards
    ? scroller.getBoundingClientRect().top - cards.getBoundingClientRect().top
    : 0;
}

/** Scrolls the shadow scroller and the component's own mirror of it together:
 *  vscode-scrollable writes `.scrollTop` back from `scrollPos` on its next
 *  render, and its wheel handler adds to `scrollPos`, so a bare `scrollTop` write
 *  would be undone by the next wheel tick. */
function scrollListTo(top: number): void {
  if (scroller) {
    scroller.scrollTop = top;
    scrollEl.scrollPos = scroller.scrollTop;
  }
}

function rowElement(key: string): HTMLElement | undefined {
  return [...resultsEl.querySelectorAll<HTMLElement>('[data-key]')].find(
    (el) => el.getAttribute('data-key') === key,
  );
}

/** Records the vertical pitch of every rendered row — to the next row's top, so
 *  any gap or margin counts — and reports whether any moved from what the
 *  windower assumed, plus how far rows wholly above the viewport grew or shrank
 *  (the scroll correction that keeps what the reader looks at in place). */
function measureRows(): { changed: boolean; shift: number } {
  const rows = results?.prepared.rows;
  const index = results?.index;
  const els = [...resultsEl.querySelectorAll<HTMLElement>('[data-key]')];
  // A hidden view lays out as zeros; recording them would poison the heights.
  if (!results || !rows || !index || els.length === 0 || scroller?.clientHeight === 0) {
    return { changed: false, shift: 0 };
  }
  const tops = els.map((el) => el.getBoundingClientRect());
  const before = measuredHeights(rows, viewOptions, rowHeights);
  let changed = false;
  let shift = 0;
  let offset = -1;
  let prev = -2;
  els.forEach((el, i) => {
    const key = el.getAttribute('data-key') ?? '';
    const at = index.get(key);
    const rect = tops[i];
    const next = tops[i + 1];
    if (at === undefined || !rect) {
      return;
    }
    // A pinned row is followed by a spacer, not by its list neighbour: restart
    // the running offset there, and never measure its pitch across the spacer.
    offset = at === prev + 1 ? offset : rowOffset(before, at);
    prev = at;
    const old = before[at] ?? 0;
    const adjacent = next && index.get(els[i + 1]?.getAttribute('data-key') ?? '') === at + 1;
    const pitch = next && adjacent ? next.top - rect.top : rect.height;
    if (pitch > 0) {
      rowHeights.set(key, pitch);
      if (Math.abs(pitch - old) > HEIGHT_EPSILON) {
        changed = true;
      }
      if (offset + old <= listScrollTop) {
        shift += pitch - old;
      }
    }
    offset += old;
  });
  return { changed, shift };
}

/** The rows the results region draws at the current scroll position: the window
 *  plus the pinned focus row (-1 when the focused row is inside the window or
 *  there is none). */
function currentWindow(rows: FlatRow[]): { start: number; end: number; pin: number } {
  const { start, end, pin } = windowRows(
    measuredHeights(rows, viewOptions, rowHeights),
    listScrollTop,
    viewportPx,
    undefined,
    undefined,
    results?.index.get(focusKey ?? '') ?? -1,
  );
  return { start, end, pin: pin?.index ?? -1 };
}

/** Draws the results region from the cached rows around the current scroll
 *  position, then sizes the spacers and measures what rendered. A measured
 *  height that differs from its estimate re-draws once, so the spacers and the
 *  window follow the real heights. */
function paintResults(): void {
  if (!state || !results) {
    return;
  }
  // Read before any pass renders: a render that shrinks the list lets the browser
  // clamp scrollTop at the bottom, and a negative shift on top of that clamp
  // would be applied twice.
  const top = scroller?.scrollTop ?? 0;
  let shift = 0;
  for (let pass = 0; pass < MAX_PAINT_PASSES; pass++) {
    const { tab, prepared } = results;
    paintedWindow = currentWindow(prepared.rows);
    const focused = resultsEl.contains(document.activeElement);
    litRender(
      renderSidebarResults(tab, activeFilter(), viewOptions, expanded, {
        scrollTop: listScrollTop,
        viewport: viewportPx,
        heights: rowHeights,
        focusKey,
        prepared,
      }),
      resultsEl,
    );
    // Inline style is blocked by the CSP; the CSSOM is not.
    for (const spacer of resultsEl.querySelectorAll<HTMLElement>('.win-spacer')) {
      spacer.style.height = `${spacer.dataset['px'] ?? 0}px`;
    }
    // The roving stop is pinned, so lit keeps its node; this only catches a
    // render that still disposed or moved it, which drops focus to the body.
    if (focused && !resultsEl.contains(document.activeElement) && focusKey !== undefined) {
      rowElement(focusKey)?.focus({ preventScroll: true });
    }
    const measured = measureRows();
    shift += measured.shift;
    if (!measured.changed) {
      break;
    }
  }
  if (scroller && Math.abs(shift) > HEIGHT_EPSILON) {
    scrollListTo(top + shift);
    measureScroll();
  }
  reportVisible();
}

/** Re-windows on the next frame — one pass per frame however fast the scroll
 *  events arrive. `force` repaints even when the window is unchanged (a width
 *  change reflows every row). */
function scheduleWindow(force = false): void {
  windowForced ||= force;
  if (windowFrame !== undefined) {
    return;
  }
  windowFrame = requestAnimationFrame(() => {
    windowFrame = undefined;
    const forced = windowForced;
    windowForced = false;
    measureScroll();
    if (!results || results.prepared.rows.length === 0) {
      return;
    }
    const { start, end, pin } = currentWindow(results.prepared.rows);
    if (
      forced ||
      start !== paintedWindow.start ||
      end !== paintedWindow.end ||
      pin !== paintedWindow.pin
    ) {
      paintResults();
    }
  });
}

/** Wires the shadow scroller in: scroll position, viewport and width. */
function attachScroller(el: HTMLElement): void {
  scroller = el;
  new ResizeObserver(() => {
    // Card heights depend on the width, but the measured map stays: clearing it
    // sends every row above the reader back to the 92 px estimate, and a reader
    // deep in a long list lands on another row. The forced repaint re-measures
    // what renders, and the shift correction keeps those rows in place.
    const width = el.clientWidth;
    const widthChanged = width !== listWidth;
    if (widthChanged) {
      listWidth = width;
    }
    scheduleWindow(widthChanged);
  }).observe(el);
  scheduleWindow(true);
}

/** Mirrors the three booleans the title bar's `when` clauses key on, so its
 *  toggles can swap icons. Sent on every view-state change, from a title-bar
 *  action or a twisty click alike. */
function postViewFlags(): void {
  post({
    type: 'viewFlags',
    flags: {
      compact: viewOptions.density === 'compact',
      tree: viewOptions.mode === 'tree',
      grouped: groupKeyFor(activeTab, viewOptions) !== 'none',
      anyExpanded: currentNodeIds().some((id) => expanded.has(id)),
      structured: activeTab !== 'updates',
    },
  });
}

/** The view controls, fired from the view's TITLE BAR (or the command palette).
 *  State stays here rather than host-side: grouping flips a different key per
 *  tab, and the active tab is webview state. */
function applyViewAction(action: ViewAction): void {
  switch (action) {
    case 'toggle-density':
      viewOptions.density = viewOptions.density === 'compact' ? 'comfortable' : 'compact';
      break;
    case 'toggle-mode':
      viewOptions.mode = viewOptions.mode === 'tree' ? 'list' : 'tree';
      if (viewOptions.mode === 'tree') {
        seedExpanded();
      }
      break;
    case 'toggle-grouping': {
      const next = cycleGroup(activeTab, groupKeyFor(activeTab, viewOptions));
      if (activeTab === 'installed') {
        viewOptions.installedGroup = next;
      } else {
        viewOptions.browseGroup = next;
      }
      if (next !== 'none') {
        seedExpanded();
      }
      break;
    }
    case 'expand-all':
      for (const id of currentNodeIds()) {
        expanded.add(id);
      }
      break;
    case 'collapse-all':
      for (const id of currentNodeIds()) {
        expanded.delete(id);
      }
      break;
  }
  persist();
  // The one place the stored PREFERENCE is written: a title-bar action is the
  // user actively switching. Twisty clicks and tab switches also call
  // postViewFlags/persist, and deliberately do not get here.
  post({ type: 'viewPrefs', view: { ...viewOptions } });
  postViewFlags();
  render();
}

// Which actions run a grim command now lives in webview/actions.ts, shared with
// the details entry. While one is in flight ANYWHERE (the host's `busy` post —
// this view, a details panel, a command), all of them are refused here, not
// merely dimmed by the .busy CSS: pointer-events still leaves a button reachable
// by keyboard, and Enter would fire the same click that grim can only stall on
// behind its lock.
let busy: string | null = null;

/** Opens a closed group header or tree node, closes an open one. */
function toggleNode(node: string): void {
  if (expanded.has(node)) {
    expanded.delete(node);
  } else {
    expanded.add(node);
  }
  persist();
  // The expand/collapse-all button flips with the first and last open node.
  postViewFlags();
  render();
}

/** The shared PREVIEW panel: what a bare row click and Enter or Space on a focused row open. */
function openPreview(repo: string): void {
  post({ type: 'openDetails', repo, mode: 'preview' });
}

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const card = (event.target as HTMLElement).closest<HTMLElement>(ROW_SELECTOR);
  if (!target) {
    const repo = card?.dataset['repo'];
    const menuWasOpen = cardMenuEl !== null || contextMenuEl !== null;
    closeCardMenu();
    closeContextMenu();
    // A bare card click opens the shared PREVIEW panel immediately — no
    // disambiguation delay: a double-click's second click is a same-repo no-op
    // host-side, and the dblclick then promotes the already-open preview in
    // place. Dismissing a menu with a click doesn't open anything.
    if (repo && !menuWasOpen) {
      openPreview(repo);
    }
    return;
  }
  event.stopPropagation();
  const action = target.dataset['action'];
  if (busy !== null && isMutating(action)) {
    closeCardMenu();
    closeContextMenu();
    return;
  }
  const repo = target.dataset['repo'] ?? card?.dataset['repo'] ?? '';
  switch (action) {
    case 'menu': {
      // Anchor on the actual clicked element: an artifact installed in both
      // scopes has two cards with the same data-repo, so a repo query would open
      // the menu on the wrong one.
      const wasOpenHere = cardMenuAnchor === target;
      closeCardMenu();
      const cardVM = cardByRepo(repo);
      if (card && cardVM && state && !wasOpenHere) {
        cardMenuEl = renderToElement(renderCardMenu(cardVM, state.scopes.projectOpen));
        root.appendChild(cardMenuEl);
        cardMenuAnchor = target;
        // Below the trigger, right edges aligned (VS Code dropdown idiom),
        // then clamped so the widget border can't cut it off.
        const anchor = target.getBoundingClientRect();
        cardMenuEl.style.top = `${anchor.bottom + 4}px`;
        cardMenuEl.style.left = `${Math.max(4, anchor.right - cardMenuEl.getBoundingClientRect().width)}px`;
        clampMenuToViewport(cardMenuEl);
      }
      return;
    }
    case 'install': {
      // Explicit chevron entries carry a scope; the main action uses the heuristic.
      const scope =
        (target.dataset['scope'] as 'project' | 'global' | undefined) ??
        defaultScope(state?.scopes ?? { projectOpen: false, projectConfigured: false });
      post({ type: 'install', ref: repo, scope });
      break;
    }
    case 'uninstall':
      post({
        type: 'uninstall',
        kind: target.dataset['kind'] ?? '',
        name: target.dataset['name'] ?? '',
        scope: (target.dataset['scope'] as 'project' | 'global') ?? 'project',
      });
      break;
    case 'update':
      post({
        type: 'update',
        kind: target.dataset['kind'] ?? '',
        name: target.dataset['name'] ?? '',
        scope: (target.dataset['scope'] as 'project' | 'global') ?? 'project',
      });
      break;
    case 'complete-install':
      // Scope-wide by nature: `grim install` re-materializes that scope's whole
      // lock. No repo rides along because none would be honoured.
      post({
        type: 'complete-install',
        scope: (target.dataset['scope'] as 'project' | 'global') ?? 'project',
      });
      break;
    case 'switch':
      post({
        type: 'switch',
        oldKind: target.dataset['kind'] ?? '',
        oldName: target.dataset['name'] ?? '',
        replacedBy: target.dataset['replacedBy'] ?? '',
        scope: (target.dataset['scope'] as 'project' | 'global') ?? 'project',
      });
      break;
    case 'pin':
      post({ type: 'pin', ref: repo });
      break;
    case 'pick-version':
      post({ type: 'pickVersion', repo });
      break;
    case 'copy':
      post({ type: 'copyRepoPath', repo });
      break;
    case 'copy-share':
      post({ type: 'copyShareLink', repo });
      break;
    case 'open-details':
      post({ type: 'openDetails', repo, mode: 'permanent' });
      break;
    case 'refresh':
      post({ type: 'refresh' });
      break;
    case 'retry-load':
      if (state?.paging?.failed === true) {
        post({ type: 'retry-load', token: state.paging.token });
        // The Retry button vanishes on success; focus would fall to the body.
        resultsEl.querySelector<HTMLElement>('.result-summary')?.focus();
      }
      break;
    case 'clear-search': {
      const input = document.getElementById('search') as HTMLInputElement | null;
      if (input) {
        input.value = '';
        input.focus();
      }
      if (activeTab === 'installed') {
        // Installed name filtering is client-side — no host round-trip.
        installedQuery = '';
        persist();
        render();
        break;
      }
      if (state) {
        state.query = '';
      }
      persist();
      syncSearchValue();
      postSearch('');
      break;
    }
    case 'init-project':
      post({ type: 'initProject' });
      break;
    case 'install-grim':
      post({ type: 'installGrim' });
      break;
    case 'show-grim-info':
      post({ type: 'showGrimInfo' });
      break;
    case 'show-output':
      post({ type: 'showOutput' });
      break;
    case 'toggle-node':
      // A twisty on a group header or tree node. The only view control still in
      // the webview — it belongs to the row, not to the view.
      toggleNode(target.dataset['node'] ?? '');
      break;
    case 'toggle-kind': {
      const current = activeFilter();
      setActiveFilter({
        ...current,
        kinds: toggleKinds(current.kinds, target.dataset['kind'] ?? ''),
      });
      persist();
      render();
      break;
    }
    case 'toggle-sort-dir': {
      if (activeTab === 'browse' && resultIsPartial(state?.paging)) {
        break; // pinned to the field's natural direction while the result is partial
      }
      const current = activeFilter();
      setActiveFilter({ ...current, dir: current.dir === 'asc' ? 'desc' : 'asc' });
      persist();
      render();
      break;
    }
    case 'set-tab':
      activeTab = (target.dataset['tab'] as SidebarTab | undefined) ?? 'browse';
      // Each tab has its own grouping key and its own node ids, so a tab that
      // arrives grouped/treed needs its top level opened the same way a fresh
      // toggle does.
      if (viewOptions.mode === 'tree' || groupKeyFor(activeTab, viewOptions) !== 'none') {
        seedExpanded();
      }
      persist();
      // Each tab has its own grouping key, so the title bar's Group/Ungroup
      // icon can flip on a tab switch alone.
      postViewFlags();
      render();
      break;
  }
  closeCardMenu();
  closeContextMenu();
});

// Double-click promotes the preview panel to a permanent tab (VS Code idiom).
root.addEventListener('dblclick', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const repo = (event.target as HTMLElement).closest<HTMLElement>(ROW_SELECTOR)?.dataset['repo'];
  if (target || !repo) {
    return;
  }
  post({ type: 'openDetails', repo, mode: 'permanent' });
});

// Right-click opens the shared card menu at the cursor.
root.addEventListener('contextmenu', (event) => {
  const cardEl = (event.target as HTMLElement).closest<HTMLElement>(ROW_SELECTOR);
  const repo = cardEl?.dataset['repo'];
  if (!repo || !state) {
    return;
  }
  const card = cardByRepo(repo);
  if (!card) {
    return;
  }
  event.preventDefault();
  closeCardMenu();
  closeContextMenu();
  const menu = renderToElement(renderCardContextMenu(card, state.scopes.projectOpen));
  root.appendChild(menu);
  contextMenuEl = menu;
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  clampMenuToViewport(menu);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  closeContextMenu();
  closeCardMenu();
});

// Roving focus: the row last focused holds the one tabindex=0, so Tab enters the
// list there. Re-rendering carries the new stop (lit owns tabindex; poking the
// DOM instead would leave its dirty-check stale).
resultsEl.addEventListener('focusin', (event) => {
  const key = (event.target as HTMLElement).closest('[data-key]')?.getAttribute('data-key');
  if (key && key !== focusKey) {
    focusKey = key;
    paintResults();
  }
});

/** Moves the roving focus to row `to` of the flattened list, rendered or not:
 *  scrolls it into the window, paints, then focuses it. */
function focusRowAt(to: number): void {
  const target = results?.prepared.rows[to];
  if (!results || !target) {
    return;
  }
  const heights = measuredHeights(results.prepared.rows, viewOptions, rowHeights);
  measureScroll();
  if (scroller) {
    const listTop = scroller.scrollTop - listScrollTop;
    scrollListTo(
      to === 0
        ? 0
        : listTop +
            revealScrollTop(rowOffset(heights, to), heights[to] ?? 0, listScrollTop, viewportPx),
    );
    measureScroll();
  }
  focusKey = target.key;
  paintResults();
  const el = rowElement(target.key);
  if (el && scroller) {
    // The scroll above was aimed with estimates; the paint measured the real
    // heights, so settle the target against its actual box.
    const box = scroller.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const clippedTop = rect.top - box.top;
    scrollListTo(
      scroller.scrollTop +
        (clippedTop < 0 || rect.height >= box.height
          ? clippedTop
          : Math.max(rect.bottom - box.bottom, 0)),
    );
  }
  el?.focus({ preventScroll: true });
}

// Rows outside the window are not in the DOM, so native Tab and scrollIntoView
// cannot reach them: arrow keys walk the whole flattened list instead, scrolling
// the target into the window before focusing it.
resultsEl.addEventListener('keydown', (event) => {
  const row =
    event.target instanceof HTMLElement && event.target.hasAttribute('data-key')
      ? event.target
      : null;
  const key = row?.getAttribute('data-key');
  if (!row || !key || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }
  // A card or compact row is a div; group headers and tree nodes are buttons
  // and keep their native Enter/Space. Space is claimed here too: left alone it
  // scrolls the list a page.
  const repo = row.matches(ROW_SELECTOR) ? row.dataset['repo'] : undefined;
  if ((event.key === 'Enter' || event.key === ' ') && repo) {
    event.preventDefault();
    closeCardMenu();
    closeContextMenu();
    openPreview(repo);
    return;
  }
  const at = results?.index.get(key);
  if (!results || at === undefined) {
    return;
  }
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    const action = treeKeyAction(results.prepared.rows, at, event.key);
    if (action) {
      event.preventDefault();
      if (action.kind === 'focus') {
        focusRowAt(action.index);
      } else {
        toggleNode(action.id);
      }
    }
    return;
  }
  const heights = measuredHeights(results.prepared.rows, viewOptions, rowHeights);
  const to = navTarget(heights, at, event.key, viewportPx);
  if (to !== null) {
    event.preventDefault();
    focusRowAt(to);
  }
});

// A click anywhere OUTSIDE this webview — an editor tab, another view, the
// workbench chrome — never reaches the click handler above (it lands in a
// different frame entirely), so an open menu would keep floating over a view
// that no longer has focus. The frame's own blur is the only signal we get for
// it, and it is exactly the moment a native menu would dismiss.
window.addEventListener('blur', () => {
  closeContextMenu();
  closeCardMenu();
});

// Every way the results list scrolls — mouse wheel, thumb drag, a
// scrollbar-track click, touch pan, or a native scrollIntoView (Tab focus,
// find-in-page) — ends up writing the component's own '.scrollable-container'
// (its render() binds .scrollTop there, and a programmatic scrollTop write
// still fires a native 'scroll' event), so one listener on that element is
// the primary path: it's the only thing that sees every case. The component's
// 'vsc-scrollable-scroll' custom event is dispatched only from its wheel and
// thumb-drag handlers (see vscode-scrollable.js's _handleComponentWheel and
// _handleScrollThumbMouseMove) — it misses scrollbar-track clicks and native
// container scrolls entirely, so it's kept only as a fallback for a future
// component version that renames or drops '.scrollable-container'. The
// shadow root doesn't exist until the component's first lit render, so wait
// for the element to upgrade and for its first updateComplete before
// reaching into it.
customElements.whenDefined('vscode-scrollable').then(() =>
  scrollEl.updateComplete.then(() => {
    // Pinned against the installed component by the render.test.ts test
    // "vscode-scrollable still ships the .scrollable-container main.ts selects".
    const container = scrollEl.shadowRoot?.querySelector<HTMLElement>('.scrollable-container');
    if (container) {
      container.addEventListener(
        'scroll',
        () => {
          closeContextMenu();
          closeCardMenu();
          scheduleWindow();
        },
        { passive: true },
      );
      // Same element, same reason it was hunted down here: it is the one that
      // clips, so it is also the one whose scroll position windows the list.
      attachScroller(container);
    } else {
      scrollEl.addEventListener('vsc-scrollable-scroll', () => {
        closeContextMenu();
        closeCardMenu();
      });
    }
  }),
);

// Whether the sort field's pending change came from a POINTER. Chromium matches
// :focus-visible on a select after a mouse pick, so the focus ring outlives the
// click and reads as a control stuck open; a keyboard pick is the one case the
// ring exists for, and it keeps it. The flag is the only way to tell the two
// apart from inside `change`.
let sortPickedByPointer = false;
root.addEventListener('pointerdown', (event) => {
  sortPickedByPointer = (event.target as HTMLElement | null)?.id === 'sort-field';
});

root.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;
  if (target.id !== 'sort-field') {
    return;
  }
  // Picking a field takes THAT field's own direction: carrying the previous one
  // over lands the reader on "oldest first" because they asked for Z-A a moment
  // ago. Same rule as the index site's control.
  const sort = (target as HTMLSelectElement).value as SortMode;
  setActiveFilter({ ...activeFilter(), sort, dir: NATURAL[sort] });
  persist();
  render();
  syncServerSort();
  if (sortPickedByPointer) {
    // lit re-renders into the SAME select element, so focus (and the ring)
    // survives the repaint — dropping it has to happen here, after it.
    (document.getElementById('sort-field') as HTMLSelectElement | null)?.blur();
  }
  sortPickedByPointer = false;
});

root.addEventListener('input', (event) => {
  const target = event.target as HTMLElement;
  if (target.id !== 'search') {
    return;
  }
  const query = (target as HTMLInputElement).value;
  if (activeTab === 'installed') {
    // Installed name filtering is pure client-side — re-render immediately,
    // nothing to debounce or post.
    installedQuery = query;
    persist();
    if (state) {
      syncSearchValue(viewForTab(state, activeTab, installedQuery));
      renderResults();
    }
    return;
  }
  if (state) {
    state.query = query;
  }
  persist();
  syncSearchValue();
  if (searchDebounce) {
    clearTimeout(searchDebounce);
  }
  searchDebounce = setTimeout(() => postSearch(query), 250);
});

/** Rows of a Browse list the host sent in pieces (`more`), held until the last
 *  piece lands so the DOM and the scroll position only ever see the whole list. */
let staged: StagedPosts | null = null;

/** The full repaint a replaced list gets: a ready/error state landing (the
 *  loading flash over painted results is handled before this, see below). */
function paintState(next: SidebarState): void {
  clearTimeout(loadingFooterTimeout);
  refreshInFlight = false;
  state = next;
  // seedExpanded needs cards, and there are none until the first state lands
  // — so a tree or grouping restored from the stored preference (or from a
  // persisted state whose expanded set was empty) gets its top level opened
  // HERE. Once per webview: re-seeding on every refresh would reopen a top
  // level the user deliberately collapsed.
  if (!seeded) {
    seeded = true;
    seedExpanded();
    postViewFlags();
  }
  render();
  syncServerSort();
}

/** The repaint a grown list gets, judged against the list last on screen. */
function paintAppended(next: SidebarState): void {
  if (!state) {
    return;
  }
  // The summary flips between loading, failed and done; those need the full
  // render (search sort control, chips), a plain page of cards does not. A new
  // `installedItems` array means the run carried an installed set.
  const flip =
    resultIsPartial(state.paging) !== resultIsPartial(next.paging) ||
    state.paging?.failed !== next.paging?.failed ||
    state.catalogIncomplete !== next.catalogIncomplete ||
    state.installedItems !== next.installedItems;
  state = next;
  if (flip) {
    render();
    syncServerSort();
  } else if (activeTab === 'browse') {
    renderResults(); // the other tabs show no browse cards
  }
}

window.addEventListener('message', (event: MessageEvent<HostToSidebar>) => {
  const message = event.data;
  if (message.type === 'state' || message.type === 'append') {
    // A refresh's loading state over painted results doesn't wipe them (no
    // skeleton flash): keep the current DOM and, if the reload is still
    // running a second later, swap only the footer to the refreshing line —
    // anything faster never shows it, so a quick refresh doesn't flicker the
    // status line. A ready/error state arriving first cancels the pending
    // swap; the render() it triggers repaints the footer in full.
    if (message.type === 'state' && keepPaintedOnLoading(state, message.state)) {
      staged = null;
      clearTimeout(loadingFooterTimeout);
      refreshInFlight = true;
      const loadingState = message.state;
      loadingFooterTimeout = setTimeout(() => {
        litRender(renderRefreshingFooter(loadingState.defaultRegistry ?? null), footerEl);
      }, 1000);
      return;
    }
    const folded = foldHostPost(staged, state, message);
    staged = folded.staged;
    if (folded.commit) {
      (folded.commit.fromState ? paintState : paintAppended)(folded.commit.state);
    }
  } else if (message.type === 'busy') {
    // Class only — no render(): the lock is CSS plus the click guard above, and
    // a repaint here would drop any open card menu for no reason.
    busy = message.busy;
    root.classList.toggle('busy', busy !== null);
  } else if (message.type === 'focusSearch') {
    // Search focus always means Browse (deep links, the details tag click, the
    // focusSearch command) — flip the tab first so the box exists and is the
    // browse one.
    if (activeTab !== 'browse') {
      activeTab = 'browse';
      persist();
      render();
    }
    const search = document.getElementById('search') as HTMLInputElement | null;
    if (search) {
      search.focus();
    } else {
      // Nothing painted yet (see focusPending) — the next render() does it.
      focusPending = true;
    }
  } else if (message.type === 'setTab') {
    // Host-driven tab switch (the activity-bar Updates row clicks through
    // here). Persisted like a user click so the tab survives a reload.
    if (activeTab !== message.tab) {
      activeTab = message.tab;
      persist();
      postViewFlags();
      render();
    }
  } else if (message.type === 'viewAction') {
    applyViewAction(message.action);
  } else if (message.type === 'viewPrefs') {
    // The host's stored preference, replayed at boot. It wins over whatever
    // this webview's own setState held: setState is per workspace and per view,
    // while this is the choice the user last made anywhere.
    Object.assign(viewOptions, message.view);
    persist();
    postViewFlags();
    render();
  }
});

// The host stamps `now` once per post; an idle sidebar would otherwise read a
// frozen "synced just now" forever. Age it locally on a timer — only the
// footer region re-renders, and the next real state post's fresh `now` wins.
// footerTickRenders (model.ts) gates the repaint so a tick can't stomp the
// pending or painted "Refreshing…" line with a stale ready footer mid-reload.
// Lives for the webview's whole process lifetime, so it's never cleared.
setInterval(() => {
  if (footerTickRenders(state, refreshInFlight)) {
    state = { ...state, now: Date.now() };
    litRender(renderSidebarFooter(viewForTab(state, activeTab, installedQuery)), footerEl);
  }
}, 30_000);

// Expose the pure pipeline for sanity checks in tests (no-op in production).
export { filterCards, renderCard };

post({ type: 'ready' });
// The title bar's toggles need their icons right from the first paint — the
// restored view state is ours, so the host learns it here.
postViewFlags();
