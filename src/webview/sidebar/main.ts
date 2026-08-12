// Sidebar webview entry: dumb event wiring over the pure lit renderers.
import './sidebar.css';
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import '@vscode-elements/elements/dist/vscode-badge/index.js';
import '@vscode-elements/elements/dist/vscode-progress-bar/index.js';
import '@vscode-elements/elements/dist/vscode-icon/index.js';
import '@vscode-elements/elements/dist/vscode-scrollable/index.js';
import { render as litRender, type TemplateResult } from 'lit-html';
import type {
  CardVM,
  HostToSidebar,
  SidebarState,
  SidebarToHost,
  ViewAction,
} from '../protocol';
import {
  CardFilter,
  DEFAULT_FILTER,
  DEFAULT_VIEW,
  buildTree,
  collectNodeIds,
  cycleGroup,
  defaultScope,
  filterCards,
  footerTickRenders,
  groupCards,
  groupKeyFor,
  installedCards,
  keepPaintedOnLoading,
  toggleKinds,
  topLevelIds,
  viewForTab,
  type GroupContext,
  type SidebarTab,
  type ViewOptions,
} from '../model';
import {
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
  installed: { ...DEFAULT_FILTER, ...(saved?.installedFilter ?? {}) },
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
    : filterCards(tabView.items, activeFilter());
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
  litRender(renderSidebarResults(view, activeFilter(), viewOptions, expanded), resultsEl);
  litRender(renderSidebarFooter(view), footerEl);
  observeVisibleRows();
  if (focusPending) {
    focusPending = false;
    (document.getElementById('search') as HTMLInputElement | null)?.focus();
  }
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
  litRender(renderSidebarSearch(toRender), searchEl);
}

function post(message: SidebarToHost): void {
  vscode.postMessage(message);
}

// --- Viewport reporting (drives the host's details prefetch) ---

// One shared observer over every row/card in the results region. rootMargin
// reaches a screenful past the viewport in both directions so a logo is already
// on its way by the time the row is scrolled into place.
const VISIBLE_MARGIN = '400px';
const VISIBLE_DEBOUNCE_MS = 300;
const visibleRepos = new Set<string>();
let visibleTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleVisiblePost(): void {
  if (visibleTimer) {
    return;
  }
  visibleTimer = setTimeout(() => {
    visibleTimer = undefined;
    if (visibleRepos.size > 0) {
      post({ type: 'visible', repos: [...visibleRepos] });
    }
  }, VISIBLE_DEBOUNCE_MS);
}

const visibilityObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const repo = (entry.target as HTMLElement).dataset.repo;
      if (repo === undefined) {
        continue;
      }
      if (entry.isIntersecting) {
        visibleRepos.add(repo);
      } else {
        visibleRepos.delete(repo);
      }
    }
    scheduleVisiblePost();
  },
  { root: scrollEl, rootMargin: VISIBLE_MARGIN },
);

/** Re-arms the observer after a render. Disconnect-and-reobserve, and the set
 *  is cleared with it: lit reuses and reorders row nodes, so a set carried
 *  across renders accumulates repos that are no longer rendered at all. The
 *  observer re-reports every currently-intersecting element asynchronously as
 *  soon as it observes them — well inside the debounce window — so the cleared
 *  set refills before anything is posted. */
function observeVisibleRows(): void {
  visibilityObserver.disconnect();
  visibleRepos.clear();
  for (const el of resultsEl.querySelectorAll('[data-repo]')) {
    visibilityObserver.observe(el);
  }
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

// Every action that runs a grim command. While one is in flight ANYWHERE (the
// host's `busy` post — this view, a details panel, a command), all of them are
// refused here, not merely dimmed by the .busy CSS: pointer-events still leaves
// a button reachable by keyboard, and Enter would fire the same click that grim
// can only stall on behind its lock.
const MUTATING_ACTIONS = new Set([
  'install',
  'uninstall',
  'update',
  'switch',
  'pin',
  'pick-version',
  'init-project',
  'install-grim',
]);
let busy: string | null = null;

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
      post({ type: 'openDetails', repo, mode: 'preview' });
    }
    return;
  }
  event.stopPropagation();
  const action = target.dataset['action'];
  if (busy !== null && MUTATING_ACTIONS.has(action ?? '')) {
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
      post({ type: 'search', query: '' });
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
    case 'toggle-node': {
      // A twisty on a group header or tree node. The only view control still in
      // the webview — it belongs to the row, not to the view.
      const node = target.dataset['node'] ?? '';
      if (expanded.has(node)) {
        expanded.delete(node);
      } else {
        expanded.add(node);
      }
      persist();
      // The expand/collapse-all button flips with the first and last open node.
      postViewFlags();
      render();
      break;
    }
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
    const scroller = scrollEl.shadowRoot?.querySelector('.scrollable-container');
    if (scroller) {
      scroller.addEventListener(
        'scroll',
        () => {
          closeContextMenu();
          closeCardMenu();
        },
        { passive: true },
      );
    } else {
      scrollEl.addEventListener('vsc-scrollable-scroll', () => {
        closeContextMenu();
        closeCardMenu();
      });
    }
  }),
);

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
      const view = viewForTab(state, activeTab, installedQuery);
      syncSearchValue(view);
      litRender(renderSidebarResults(view, activeFilter(), viewOptions, expanded), resultsEl);
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
  searchDebounce = setTimeout(() => post({ type: 'search', query }), 250);
});

window.addEventListener('message', (event: MessageEvent<HostToSidebar>) => {
  const message = event.data;
  if (message.type === 'state') {
    // A refresh's loading state over painted results doesn't wipe them (no
    // skeleton flash): keep the current DOM and, if the reload is still
    // running a second later, swap only the footer to the refreshing line —
    // anything faster never shows it, so a quick refresh doesn't flicker the
    // status line. A ready/error state arriving first cancels the pending
    // swap; the render() it triggers repaints the footer in full.
    if (keepPaintedOnLoading(state, message.state)) {
      clearTimeout(loadingFooterTimeout);
      refreshInFlight = true;
      const loadingState = message.state;
      loadingFooterTimeout = setTimeout(() => {
        litRender(renderRefreshingFooter(loadingState.defaultRegistry ?? null), footerEl);
      }, 1000);
      return;
    }
    clearTimeout(loadingFooterTimeout);
    refreshInFlight = false;
    state = message.state;
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
