// Sidebar webview entry: dumb event wiring over the pure lit renderers.
import './sidebar.css';
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import '@vscode-elements/elements/dist/vscode-badge/index.js';
import '@vscode-elements/elements/dist/vscode-progress-bar/index.js';
import '@vscode-elements/elements/dist/vscode-icon/index.js';
import '@vscode-elements/elements/dist/vscode-scrollable/index.js';
import { render as litRender, type TemplateResult } from 'lit-html';
import type { CardVM, HostToSidebar, SidebarState, SidebarToHost } from '../protocol';
import {
  CardFilter,
  DEFAULT_FILTER,
  defaultScope,
  filterCards,
  footerTickRenders,
  keepPaintedOnLoading,
  toggleKinds,
  viewForTab,
  type SidebarTab,
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
let searchDebounce: ReturnType<typeof setTimeout> | undefined;
// A reload over painted content doesn't show "Refreshing…" immediately — only
// once it's taken more than a second (a quick refresh would otherwise flicker
// the status line). Cleared whenever a ready/error state lands first.
let loadingFooterTimeout: ReturnType<typeof setTimeout> | undefined;
// True from a kept-painted loading state until the next ready/error state.
let refreshInFlight = false;
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
  });
}

/** The active tab's filter. Updates has no filter UI — its chips never render,
 *  so the default is only ever read, never mutated. */
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
    state?.items.find((c) => c.repo === repo) ??
    state?.installedItems.find((c) => c.repo === repo)
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
  litRender(renderSidebarResults(view, activeFilter()), resultsEl);
  litRender(renderSidebarFooter(view), footerEl);
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

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const card = (event.target as HTMLElement).closest<HTMLElement>('.card');
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
    case 'set-scope':
      // Installed tab scope toggle — client-side, persisted like the kind filter.
      filters.installed = {
        ...filters.installed,
        scope: target.dataset['scope'] as 'project' | 'global',
      };
      persist();
      render();
      break;
    case 'set-tab':
      activeTab = (target.dataset['tab'] as SidebarTab | undefined) ?? 'browse';
      persist();
      render();
      break;
  }
  closeCardMenu();
  closeContextMenu();
});

// Double-click promotes the preview panel to a permanent tab (VS Code idiom).
root.addEventListener('dblclick', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const repo = (event.target as HTMLElement).closest<HTMLElement>('.card')?.dataset['repo'];
  if (target || !repo) {
    return;
  }
  post({ type: 'openDetails', repo, mode: 'permanent' });
});

// Right-click opens the shared card menu at the cursor.
root.addEventListener('contextmenu', (event) => {
  const cardEl = (event.target as HTMLElement).closest<HTMLElement>('.card');
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
      litRender(renderSidebarResults(view, activeFilter()), resultsEl);
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
    render();
  } else if (message.type === 'focusSearch') {
    // Search focus always means Browse (deep links, the details tag click, the
    // focusSearch command) — flip the tab first so the box exists and is the
    // browse one.
    if (activeTab !== 'browse') {
      activeTab = 'browse';
      persist();
      render();
    }
    (document.getElementById('search') as HTMLInputElement | null)?.focus();
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
