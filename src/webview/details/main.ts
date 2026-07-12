// Details webview entry: renders the artifact page and the markdown bodies.
import './details.css';
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-progress-ring/index.js';
import { nothing, render as litRender } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import type { DetailsToHost, DetailsVM, HostToDetails, RevalidateState, Scope } from '../protocol';
import { createMarkdown } from '../markdown';
import { isInteractiveTarget, shouldResetUi } from '../model';
import { renderDetails, revalidateIndicator } from '../render';

declare function acquireVsCodeApi(): {
  postMessage(message: DetailsToHost): void;
  getState(): { repo?: string } | undefined;
  setState(state: { repo?: string }): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;
// html:false (default) — raw HTML in fetched markdown stays inert; the factory
// also permits our data:image/svg+xml companion images (see createMarkdown).
const md = createMarkdown();

// The host injects the repo via a data attribute on the root element; the
// serializer restore path falls back to persisted state.
const repo = root.dataset['repo'] ?? vscode.getState()?.repo ?? '';
vscode.setState({ repo });

let vm: DetailsVM | null = null;
// The artifact currently rendered. The preview tab is retargeted in place (no
// webview reboot), so a VM for a different repo can arrive; null until the first
// render lands.
let currentRepo: string | null = null;

// Per-panel UI state renderDetails does NOT carry in the VM. Under the old
// innerHTML-wipe render these reset "for free" on every message; lit keeps the
// DOM across re-renders, so they are explicit here: re-applied after every
// render (applyUiState) and reset on retarget (resetForRetarget). null activeTab
// / null openScopeMenu / false tagsExpanded each mean "the template's default".
let activeTab: string | null = null;
let openScopeMenu: Element | null = null;
let tagsExpanded = false;

// renderDetails marks a default active tab server-side (item 5): README when the
// artifact ships one, else CONTENTS; the loading skeleton always leads with
// CONTENTS. activeTab overrides that once the user picks a tab.
function defaultTab(): string {
  if (!vm || vm.loading) {
    return 'contents';
  }
  return vm.readmeMarkdown !== null ? 'details' : 'contents';
}

// Reconcile the tab strip and panels to activeTab (or the server default). lit's
// per-binding dirty check won't undo a stale imperative `.active`, so this runs
// authoritatively on every render rather than trusting the template's class.
function applyTabState(): void {
  const active = activeTab ?? defaultTab();
  document
    .querySelectorAll('.tab')
    .forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset['tab'] === active));
  document
    .querySelectorAll('.tab-panel')
    .forEach((panel) => panel.classList.toggle('hidden', panel.id !== `panel-${active}`));
}

// The install split button and the per-scope gear rows (design 2a) share the
// .scope-menu family; only one opens at a time. renderDetails ships them all
// closed (static `.hidden`), so a null openScopeMenu leaves them closed.
function applyScopeMenuState(): void {
  document
    .querySelectorAll('.scope-menu')
    .forEach((m) => m.classList.toggle('hidden', m !== openScopeMenu));
}

function toggleScopeMenu(menu: Element | null | undefined): void {
  // Re-clicking the open menu closes it; opening one closes the rest.
  openScopeMenu = menu && menu === openScopeMenu ? null : (menu ?? null);
  applyScopeMenuState();
}

function closeScopeMenus(): void {
  openScopeMenu = null;
  applyScopeMenuState();
}

// The tags rail expands once (PACKAGE panel "+N more"); there is no collapse.
function applyTagsState(): void {
  document.querySelector('.rail-tags')?.classList.toggle('expanded', tagsExpanded);
}

// Re-apply every piece of transient UI state after a render() rebuilds the tree.
function applyUiState(): void {
  applyTabState();
  applyScopeMenuState();
  applyTagsState();
}

// Background-revalidate indicator state (top-right). Held here so a content
// repost's re-render can restore it; the 'done' fade auto-clears it after ~2s.
let revalidateState: RevalidateState | null = null;
let revalidateMessage: string | undefined;
let doneTimer: ReturnType<typeof setTimeout> | undefined;

// Stamp the current revalidate state onto the fixed top-right host. renderDetails
// emits it once (empty, base class) and never rebinds it — but the host node
// persists across lit re-renders, so this is no longer called from render() (the
// old innerHTML-wipe restamp is gone). Driven only by the 'revalidate' message,
// its done-fade timer, and the retarget reset. The state-* class is load-bearing
// (CSS fade + failed pointer-events), so it is set alongside the lit-rendered
// content.
function applyRevalidate(): void {
  const el = document.getElementById('revalidate-indicator');
  if (!el) {
    return;
  }
  el.className = `revalidate-indicator${revalidateState ? ` state-${revalidateState}` : ''}`;
  litRender(revalidateIndicator(revalidateState, revalidateMessage), el);
}

function setRevalidate(state: RevalidateState, message?: string): void {
  clearTimeout(doneTimer);
  revalidateState = state;
  revalidateMessage = message;
  applyRevalidate();
  // 'done' fades via CSS, then clears so a later re-render can't re-show it.
  if (state === 'done') {
    doneTimer = setTimeout(() => {
      revalidateState = null;
      applyRevalidate();
    }, 2000);
  }
}

// A message-driven preview retarget swaps the artifact without a webview reboot,
// so per-panel state that outlives the DOM must be reset by hand: scroll to top,
// drop the previous artifact's revalidate indicator, and reset the transient UI
// state (active tab, open scope menu, tags rail) that lit would otherwise keep.
function resetForRetarget(): void {
  clearTimeout(doneTimer);
  revalidateState = null;
  revalidateMessage = undefined;
  applyRevalidate(); // clear the old indicator now — render() no longer restamps it
  activeTab = null;
  openScopeMenu = null;
  tagsExpanded = false;
  window.scrollTo(0, 0);
}

// Fill one of renderDetails' three empty markdown slots. markdown-it output is
// html:false (inert) and injected via unsafeHTML, never as a raw string. Null
// clears the slot (md-contents survives across kinds even when its markdown does
// not) so a same-repo repost can't leave a stale body behind.
function renderMarkdown(id: string, markdown: string | null): void {
  const element = document.getElementById(id);
  if (!element) {
    return;
  }
  litRender(markdown ? unsafeHTML(md.render(markdown)) : nothing, element);
}

let firstRender = true;
function render(): void {
  if (!vm) {
    return;
  }
  if (firstRender) {
    // Drop the host's SSR skeleton (which carries its own lit part markers) once
    // so lit renders into a clean #root instead of appending beside it.
    root.replaceChildren();
    firstRender = false;
  }
  litRender(renderDetails(vm), root);
  // renderDetails leaves the tab/menu/tags classes at their server defaults and
  // the markdown slots empty; re-apply the live UI state and fill the bodies.
  applyUiState();
  // Tab semantics (item 5): DETAILS is the README (only when shipped); CONTENTS
  // is the artifact's own source markdown (mcp/bundle content is JSON, rendered
  // server-side in renderDetails, so #md-contents is absent for those).
  renderMarkdown('md-details', vm.readmeMarkdown);
  renderMarkdown('md-contents', vm.contentMarkdown);
  renderMarkdown('md-changelog', vm.changelogMarkdown);
}

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action], .tab, a[href]');
  if (!target) {
    closeScopeMenus();
    return;
  }
  if (target.classList.contains('tab')) {
    if (target.hasAttribute('disabled')) {
      return;
    }
    activeTab = target.dataset['tab'] ?? 'contents';
    applyTabState();
    return;
  }
  const action = target.dataset['action'];
  if (!action) {
    // Markdown links: route through the host so they open externally.
    const href = target.getAttribute('href');
    if (href && /^https?:/.test(href)) {
      event.preventDefault();
      vscode.postMessage({ type: 'openExternal', url: href });
    }
    return;
  }
  event.preventDefault();
  switch (action) {
    case 'scope-menu':
      toggleScopeMenu(target.closest('.split-button')?.querySelector('.scope-menu'));
      return;
    case 'scope-gear':
      toggleScopeMenu(target.closest('.scope-gear')?.querySelector('.scope-menu'));
      return;
    case 'install': {
      const scope = target.dataset['scope'];
      const resolved =
        scope === 'project' || scope === 'global'
          ? scope
          : vm?.scopes.projectOpen && vm.scopes.projectConfigured
            ? 'project'
            : 'global';
      // The host derives the target from repoOf(panel); no ref is sent.
      vscode.postMessage({ type: 'install', scope: resolved });
      break;
    }
    case 'update':
      vscode.postMessage({
        type: 'update',
        kind: target.dataset['kind'] ?? '',
        name: target.dataset['name'] ?? '',
        scope: (target.dataset['scope'] as 'project' | 'global') ?? 'project',
      });
      break;
    case 'uninstall':
      vscode.postMessage({
        type: 'uninstall',
        kind: target.dataset['kind'] ?? '',
        name: target.dataset['name'] ?? '',
        scope: (target.dataset['scope'] as 'project' | 'global') ?? 'project',
      });
      break;
    case 'pick-version': {
      // The host derives the target from repoOf(panel); no repo is sent.
      const scope = target.dataset['scope'] as Scope | undefined;
      vscode.postMessage({ type: 'pickVersion', ...(scope ? { scope } : {}) });
      break;
    }
    case 'open':
      vscode.postMessage({ type: 'openExternal', url: target.dataset['url'] ?? '' });
      break;
    case 'open-details': {
      const repoTarget = target.dataset['repo'];
      if (repoTarget) {
        vscode.postMessage({ type: 'openDetails', repo: repoTarget });
      }
      break;
    }
    case 'toggle-tags':
      tagsExpanded = true;
      applyTagsState();
      break;
    case 'copy':
      vscode.postMessage({ type: 'copyRepoPath', repo: target.dataset['repo'] ?? '' });
      break;
    case 'copy-share':
      vscode.postMessage({ type: 'copyShareLink', repo: target.dataset['repo'] ?? '' });
      break;
    case 'search-tag':
      vscode.postMessage({ type: 'searchTag', tag: target.dataset['tag'] ?? '' });
      break;
    case 'revalidate-error':
      // Host looks up the stored message by repo — no webview text is trusted.
      vscode.postMessage({ type: 'revalidateError' });
      break;
    case 'promote':
      vscode.postMessage({ type: 'promote' });
      break;
  }
  // Any menu entry that acted (copy, pick-version, install…) dismisses the menu.
  closeScopeMenus();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeScopeMenus();
    return;
  }
  // Member boxes/rows act as buttons (role="button"); Enter/Space triggers the
  // same open-details click. Space would otherwise scroll — preventDefault it.
  if (event.key === 'Enter' || event.key === ' ') {
    const box = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[role="button"][data-action]',
    );
    if (box) {
      event.preventDefault();
      box.click();
    }
  }
});

// Double-clicking the panel body promotes a preview tab to permanent (VS Code's
// keep-open gesture, which webview panels have no API for) — but not when the
// click landed on an interactive control (button, link, tab, data-action).
root.addEventListener('dblclick', (event) => {
  if (isInteractiveTarget(event.target as HTMLElement | null)) {
    return;
  }
  vscode.postMessage({ type: 'promote' });
});

window.addEventListener('scroll', () => closeScopeMenus(), true);

window.addEventListener('message', (event: MessageEvent<HostToDetails>) => {
  const message = event.data;
  if (message.type === 'artifact') {
    if (shouldResetUi(currentRepo, message.vm.repo)) {
      resetForRetarget();
    }
    currentRepo = message.vm.repo;
    vscode.setState({ repo: currentRepo }); // keep serialization truth in sync across retargets
    vm = message.vm;
    render();
  } else if (message.type === 'busy' && vm) {
    vm.busy = message.action;
    render();
  } else if (message.type === 'revalidate') {
    setRevalidate(message.state, message.message);
  } else if (message.type === 'promoted' && vm) {
    // The panel left the preview slot — drop the header pin (isPreview rides on
    // the VM, re-read on render, so no separate reset needed on retarget).
    vm.isPreview = false;
    render();
  }
});

vscode.postMessage({ type: 'ready', repo });
