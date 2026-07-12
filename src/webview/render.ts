// lit-html renderers for both webviews. No DOM access at module scope — the
// browser entries render the returned templates into their containers and wire
// events via delegation; the extension host renders the details skeleton to a
// string through @lit-labs/ssr. lit auto-escapes every interpolated binding
// (its SSR escaper is byte-for-byte esc(), the same five entities), so the
// templates carry raw values — the standalone esc()/kindIcon()/formatDate()/
// highlightJson() helpers below stay string functions because the host, the
// tests, and the JSON highlighter consume them directly. Interactive
// primitives are @vscode-elements/elements custom elements (vscode-button,
// vscode-textfield, vscode-single-select, vscode-badge, vscode-progress-bar);
// kind badges, chips, cards and menus are hand-styled per the design mockups.
import { html, nothing, type TemplateResult } from 'lit-html';
import { ifDefined } from 'lit-html/directives/if-defined.js';
import { repeat } from 'lit-html/directives/repeat.js';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import type {
  BundleMemberVM,
  CardVM,
  DetailsVM,
  InstallVM,
  RevalidateState,
  Scope,
  SidebarState,
} from './protocol';
import {
  CardFilter,
  KIND_ICONS,
  cardMenuEntries,
  concreteVersion,
  effectiveInstall,
  filterCards,
  installedViewCards,
  normalizeKind,
  registriesOf,
  registryLabel,
  relativeTime,
  resolveInstalledScope,
  scopeRowMenuEntries,
  searchCards,
  viaBundleTitle,
  type MenuEntry,
} from './model';

export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function kindIcon(kind: string | null): string {
  const normalized = normalizeKind(kind);
  return normalized ? KIND_ICONS[normalized] : 'question';
}

/** kind-tinted class for icon tiles and KIND badges (design 1a/1g). */
function kindClass(kind: string | null): string {
  return normalizeKind(kind) ? `kind-${normalizeKind(kind)}` : 'kind-unknown';
}

function kindTile(kind: string | null, extra = ''): TemplateResult {
  return html`<div class="kind-tile ${kindClass(kind)}${extra ? ` ${extra}` : ''}"><span class="codicon codicon-${kindIcon(kind)}"></span></div>`;
}

/** A browse card's leading tile: the cached logo (prefetched) when present, else
 *  the kind-tinted codicon tile. lit escapes the data: URI like any binding. */
function cardTile(card: CardVM): TemplateResult {
  return card.logoUri
    ? html`<div class="kind-tile has-logo ${kindClass(card.kind)}"><img class="card-logo" src="${card.logoUri}" alt=""/></div>`
    : kindTile(card.kind);
}

function kindBadge(kind: string | null): TemplateResult | typeof nothing {
  const normalized = normalizeKind(kind);
  return normalized
    ? html`<span class="kind-badge ${kindClass(kind)}">${normalized.toUpperCase()}</span>`
    : nothing;
}

/** Muted italic "Not provided" for null fields (design 1d). The default render
 *  yields the raw value as a text binding (lit escapes it); callers that need
 *  markup pass a TemplateResult-returning render. */
function valueOr(value: string | null, render: (v: string) => unknown = (v) => v): unknown {
  return value === null || value === ''
    ? html`<span class="null-value">Not provided</span>`
    : render(value);
}

function scopeLabel(scope: 'project' | 'global', projectName: string | null): string {
  return scope === 'project' ? `Project${projectName ? ` — ${projectName}` : ''}` : 'Global';
}

function clientChips(clients: string[]): TemplateResult[] {
  return clients.map((c) => html`<span class="client-chip">${c}</span>`);
}

/** design-2b installed box: one bordered chip for the effective scope. Scope
 *  only — the pinned version made the chip too long on browse cards (user);
 *  versions live in the details scope box. */
function installedChip(install: InstallVM): TemplateResult {
  const icon = install.scope === 'project' ? 'root-folder' : 'globe';
  const label = install.scope === 'project' ? 'Project' : 'Global';
  // Leading check per the 1g installed-state matrix.
  return html`<span class="installed-chip"><span class="codicon codicon-check installed-chip-check"></span><span class="codicon codicon-${icon}"></span><span class="installed-chip-scope">${label}</span></span>`;
}

/** Install split button on browse cards: main installs the default scope, the
 *  chevron opens the shared card menu (scope choices + Install specific
 *  version…). Deprecated artifacts demote to a single secondary Install (state
 *  matrix 1g) — the version picker stays reachable via the right-click menu. */
function cardInstallButton(card: CardVM): TemplateResult {
  if (card.state === 'deprecated') {
    return html`<button class="card-btn secondary" data-action="install" data-repo="${card.repo}">Install</button>`;
  }
  return html`<div class="split-button sm"><button class="split-main" data-action="install" data-repo="${card.repo}">Install</button><button class="split-arrow" data-action="menu" title="Install options"><span class="codicon codicon-chevron-down"></span></button></div>`;
}

/** Right-aligned action cluster on the card meta line (state matrix, 1g). */
function cardAction(card: CardVM): TemplateResult {
  if (card.state === 'outdated') {
    const target = card.installs.find((i) => i.updateAvailable);
    const to = card.latestVersion
      ? html`<span class="update-hint mono">→ ${card.latestVersion}</span>`
      : nothing;
    return html`${to}<button class="card-btn" data-action="update" data-kind="${target?.kind ?? ''}" data-name="${target?.name ?? ''}" data-scope="${target?.scope ?? 'project'}">Update</button>`;
  }
  const install = effectiveInstall(card.installs);
  if (install) {
    return html`${installedChip(install)}<button class="icon-button" data-action="menu" title="Manage"><span class="codicon codicon-gear"></span></button>`;
  }
  return cardInstallButton(card);
}

/** Renders the shared menu-entry model (model.cardMenuEntries) to templates.
 *  MenuEntry.data has a CLOSED key set (repo/scope/kind/name — see model.ts), so
 *  each is bound through ifDefined: an absent key omits its attribute, matching
 *  the old object-spread that only emitted present keys. */
function renderMenuEntries(entries: MenuEntry[]): TemplateResult[] {
  return entries.map((entry) => {
    if (entry === 'separator') {
      return html`<div class="menu-separator"></div>`;
    }
    const hint = entry.hint ? html`<span class="menu-hint">${entry.hint}</span>` : nothing;
    if (!entry.action) {
      return html`<button class="menu-item" disabled title="${ifDefined(entry.title)}">${entry.label}${hint}</button>`;
    }
    const d = entry.data ?? {};
    return html`<button class="menu-item" data-action="${entry.action}" data-repo="${ifDefined(d.repo)}" data-scope="${ifDefined(d.scope)}" data-kind="${ifDefined(d.kind)}" data-name="${ifDefined(d.name)}">${entry.label}${hint}</button>`;
  });
}

/** Gear menu for an installed card (design 2b). */
export function renderCardMenu(card: CardVM, projectOpen: boolean): TemplateResult {
  return html`<div class="card-menu">${renderMenuEntries(cardMenuEntries(card, { projectOpen, context: false }))}</div>`;
}

/** Right-click context menu — same builder, positioned at the cursor by main.ts. */
export function renderCardContextMenu(card: CardVM, projectOpen: boolean): TemplateResult {
  return html`<div class="card-menu card-context-menu">${renderMenuEntries(cardMenuEntries(card, { projectOpen, context: true }))}</div>`;
}

export interface CardVariant {
  /** 'updates' = version-delta row (1e UPDATES); 'scope' = client-chip row (1e sections). */
  variant?: 'browse' | 'updates' | 'scope';
  scope?: 'project' | 'global';
}

export function renderCard(card: CardVM, options: CardVariant = {}): TemplateResult {
  const variant = options.variant ?? 'browse';
  const deprecatedClass = card.state === 'deprecated' ? ' deprecated' : '';
  const version = card.latestVersion
    ? html`<span class="version mono">${card.latestVersion}</span>`
    : nothing;
  const deprecatedLine = card.deprecated
    ? html`<div class="card-desc deprecated-msg"><span class="codicon codicon-warning"></span> ${card.deprecated}</div>`
    : nothing;
  const title = html`
    <div class="card-title">
      <span class="card-name">${card.name}</span>
      ${version}
      ${kindBadge(card.kind)}
    </div>`;
  let body: TemplateResult;
  if (variant === 'updates') {
    const install = card.installs.find((i) => i.updateAvailable) ?? card.installs[0];
    // A floating install (grim pinned:null) tracks a moving tag — flag it, but
    // stay truthful: we know it floats, not that a tag rolled forward.
    const floating = install?.floating
      ? html` <span class="floating-note">· floating tag</span>`
      : nothing;
    const delta = html`<div class="card-delta mono">${install?.version ?? ''} <span class="codicon codicon-arrow-right"></span> <span class="delta-to">${card.latestVersion ?? ''}</span>${floating}</div>`;
    const where = install
      ? `${install.scope === 'project' ? 'Project' : 'Global'}${install.clients.length > 0 ? ` · ${install.clients.join(', ')}` : ''}`
      : '';
    body = html`${title}${delta}
    <div class="card-meta"><span class="card-where">${where}</span>
      <span class="card-actions"><button class="card-btn" data-action="update" data-kind="${install?.kind ?? ''}" data-name="${install?.name ?? ''}" data-scope="${install?.scope ?? 'project'}">Update</button></span>
    </div>`;
  } else if (variant === 'scope') {
    const install = card.installs.find((i) => i.scope === options.scope) ?? card.installs[0];
    const extras =
      card.kind === 'bundle'
        ? html`<span class="card-where">${card.installs.length} ${card.installs.length === 1 ? 'scope' : 'scopes'}</span>`
        : nothing;
    body = html`${title}${deprecatedLine}
    <div class="card-meta">${extras}${clientChips(install?.clients ?? [])}
      <span class="card-actions"><span class="codicon codicon-check installed-check" title="Installed"></span><button class="icon-button" data-action="menu" title="Manage"><span class="codicon codicon-gear"></span></button></span>
    </div>`;
  } else {
    const description = card.deprecated
      ? deprecatedLine
      : html`<div class="card-desc">${card.description ?? ''}</div>`;
    // Private registries (a stored credential) get a lock glyph before the
    // host; the meta line shows host + first org segment (design html:227/277).
    const lock = card.privateRegistry
      ? html`<span class="codicon codicon-lock registry-lock"></span>`
      : nothing;
    body = html`${title}${description}
    <div class="card-meta">
      <span class="registry mono">${lock}${registryLabel(card.repo)}</span>
      <span class="card-actions">${cardAction(card)}</span>
    </div>`;
  }
  return html`
<div class="card${deprecatedClass}" data-repo="${card.repo}">
  ${cardTile(card)}
  <div class="card-body">${body}</div>
</div>`;
}

const KIND_CHIPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'skill', label: 'Skill' },
  { id: 'rule', label: 'Rule' },
  { id: 'agent', label: 'Agent' },
  { id: 'mcp', label: 'MCP' },
  { id: 'bundle', label: 'Bundle' },
];

/** Kind multi-select chip row (replaces the dropdown): All + a chip per kind
 *  with its codicon. All is active exactly when the selection is empty. */
function kindChips(filter: CardFilter): TemplateResult {
  const chips = KIND_CHIPS.map(({ id, label }) => {
    const active = id === 'all' ? filter.kinds.length === 0 : filter.kinds.includes(id);
    const icon = id === 'all' ? nothing : html`<span class="codicon codicon-${kindIcon(id)}"></span>`;
    return html`<button class="kind-chip${active ? ' active' : ''}" data-action="toggle-kind" data-kind="${id}" aria-pressed="${active}">${icon}${label}</button>`;
  });
  return html`<div class="kind-chips">${chipGroupLabel('KIND')}${chips}</div>`;
}

/** A non-interactive mini-header captioning a chip row (flex-basis:100% pushes
 *  the chips onto the next line — a stacked header with no wrapper element). */
function chipGroupLabel(text: string): TemplateResult {
  return html`<span class="chip-group-label">${text}</span>`;
}

function renderFilters(filter: CardFilter): TemplateResult {
  // Search always spans every configured registry — no registry filter. Installed
  // artifacts live in their own views now, so no "Installed" filter chip here.
  return html`
<div class="filters">
  ${kindChips(filter)}
</div>`;
}

/** Installed view: Kind chips + the SCOPE toggle (which scope's list to show).
 *  Updates gets no filters. */
function renderInstalledFilters(state: SidebarState, filter: CardFilter): TemplateResult {
  return html`
<div class="filters">
  ${kindChips(filter)}
  ${scopeChips(state, filter)}
</div>`;
}

/** Installed view SCOPE toggle: folder=Project / globe=Global, exactly one active
 *  (the resolved scope). Project is disabled with no workspace open; an open but
 *  unconfigured workspace keeps it enabled (the init banner covers it). */
function scopeChips(state: SidebarState, filter: CardFilter): TemplateResult {
  const active = resolveInstalledScope(filter.scope, state.scopes);
  const chip = (target: Scope, label: string, icon: string, disabled: boolean): TemplateResult => {
    const title = disabled ? 'No workspace folder open — Project scope unavailable' : `Show ${label}`;
    return html`<button class="kind-chip${active === target ? ' active' : ''}" data-action="set-scope" data-scope="${target}" ?disabled="${disabled}" aria-pressed="${active === target}" title="${title}"><span class="codicon codicon-${icon}"></span>${label}</button>`;
  };
  return html`<div class="kind-chips scope-chips">${chipGroupLabel('SCOPE')}${chip('project', 'Project', 'root-folder', !state.scopes.projectOpen)}${chip('global', 'Global', 'globe', false)}</div>`;
}

function renderFooter(state: SidebarState): TemplateResult {
  const registries = registriesOf(state.items).length;
  // The timestamp lives in its own span (.footer-ts) so a 30s aging tick in
  // sidebar/main.ts can re-render just that text node, not the whole footer.
  const synced =
    state.syncedAt !== null
      ? html`Catalog cache · <span class="footer-ts">synced ${relativeTime(state.syncedAt, state.now)}</span>`
      : '';
  const suffix =
    registries > 0
      ? html`<span class="footer-right">${registries} ${registries === 1 ? 'registry' : 'registries'}</span>`
      : nothing;
  return html`<div class="footer"><span class="codicon codicon-cloud"></span><span>${synced}</span>${suffix}</div>`;
}

function renderNoGrim(): TemplateResult {
  return html`
<div class="empty-state">
  <span class="codicon codicon-warning empty-icon"></span>
  <p class="title">grim was not found</p>
  <p>The <code>grim</code> CLI is not on your PATH.</p>
  <vscode-button data-action="install-grim">Install grim</vscode-button>
  <p class="hint">Or set <code>grimoire.path.executable</code> in Settings.</p>
</div>`;
}

function renderEmpty(state: SidebarState): TemplateResult {
  const registries = registriesOf(state.items).length || 1;
  const synced =
    state.syncedAt !== null
      ? ` The catalog was last synced ${relativeTime(state.syncedAt, state.now)}.`
      : '';
  return html`
<div class="empty-state">
  <span class="codicon codicon-search empty-icon"></span>
  <p class="title">No artifacts found</p>
  <p>Nothing matches “${state.query}” across ${registries} ${registries === 1 ? 'registry' : 'registries'}.${synced}</p>
  <div class="empty-links">
    <button class="link-button" data-action="clear-search">Clear search</button>
    <button class="link-button" data-action="refresh">Refresh catalog</button>
  </div>
</div>`;
}

function renderLoading(defaultRegistry: string | null): TemplateResult {
  // Fade is applied via .skeleton-row-N classes — inline style= is blocked by
  // the webview CSP (style-src is nonce/cspSource only). Line widths vary per
  // row (design html:333) so the skeleton doesn't read as four clones.
  const skeleton = (w1: string, w2: string, w3: string, fade: string): TemplateResult => html`
  <div class="skeleton-row${fade ? ` ${fade}` : ''}">
    <div class="skeleton-tile"></div>
    <div class="skeleton-lines"><div class="skeleton-line ${w1}"></div><div class="skeleton-line thin ${w2}"></div><div class="skeleton-line thin ${w3}"></div></div>
  </div>`;
  return html`<vscode-progress-bar></vscode-progress-bar>${skeleton('w55', 'w92', 'w70', '')}${skeleton('w44', 'w88', 'w62', 'skeleton-row-2')}${skeleton('w60', 'w80', 'w74', 'skeleton-row-3')}${skeleton('w50', 'w85', 'w58', 'skeleton-row-4')}${renderRefreshingFooter(defaultRegistry)}`;
}

/** The "Refreshing from <host>…" line. Standalone so a background refresh over
 *  an already-painted list swaps only the footer while the cards stay put. */
export function renderRefreshingFooter(
  defaultRegistry: string | null,
): TemplateResult | typeof nothing {
  return defaultRegistry
    ? html`<div class="footer loading-footer"><span class="codicon codicon-sync"></span><span>Refreshing from ${defaultRegistry}…</span></div>`
    : nothing;
}

/** Workspace-level notice slot at the very top of the view, ABOVE the tab bar
 *  (its own #sb-notice region in main.ts) — normal flow, never overlaying the
 *  results. Notification look (VS Code notification tokens + info icon), not
 *  the old blockquote-style box. Self-gating: no-grim and first-load states
 *  post no snapshot, so projectOpen is false and nothing renders. */
export function renderSidebarNotice(state: SidebarState): TemplateResult | typeof nothing {
  if (!state.scopes.projectOpen || state.scopes.projectConfigured) {
    return nothing;
  }
  return html`
<div class="init-notification">
  <span class="codicon codicon-info init-icon"></span>
  <div class="init-body">
    <span>No grimoire.toml in this workspace — project scope is unavailable.</span>
    <vscode-button class="sm" secondary data-action="init-project">Initialize project</vscode-button>
  </div>
</div>`;
}

/** One installed view's flat card list (native-views split — the workbench owns
 *  the section chrome now). Host posts only this view's cards; here we apply the
 *  Kind filter and a client-side name filter for the search box. */
function renderInstalledResults(state: SidebarState, filter: CardFilter): TemplateResult {
  if (state.mode === 'updates') {
    const named = searchCards(filterCards(state.items, filter), state.query);
    return named.length
      ? html`${repeat(named, (c) => c.repo, (c) => renderCard(c, { variant: 'updates' }))}`
      : installedEmpty('Everything is up to date.');
  }
  // Installed view: the SCOPE toggle picks which scope's list shows (the host
  // posts both scopes' installs; we slice here) — installedViewCards runs the
  // kind + name + scope pipeline, the SAME array the sidebar badge count reads.
  const scope = resolveInstalledScope(filter.scope, state.scopes);
  const cards = installedViewCards(state, filter);
  const emptyText =
    scope === 'project' ? 'Nothing installed in this project.' : 'Nothing installed globally.';
  // Keyed by repo + scope: the same artifact installed in both scopes must key
  // distinctly if the two ever land in one list (spec sidebar-card key rule).
  // The initialize-project notice lives in the top #sb-notice slot (above the
  // tabs, all modes) — no inline copy here.
  return cards.length
    ? html`${repeat(cards, (c) => `${scope}:${c.repo}`, (c) => renderCard(c, { variant: 'scope', scope }))}`
    : installedEmpty(emptyText);
}

function installedEmpty(text: string): TemplateResult {
  return html`<div class="installed-empty">${text}</div>`;
}

/** Item 3: the sidebar renders as three independently-updatable regions —
 *  search row, filter row, results — so a search-result state update rebuilds
 *  only the results (and, when its options change, the filters) and never the
 *  textfield the user is typing into. main.ts drives them separately; this
 *  composed form stays for the render tests and any full-render fallback. */
export function renderSidebarSearch(state: SidebarState): TemplateResult | typeof nothing {
  // The Updates view has no search box (short, single-purpose list).
  if (state.phase === 'no-grim' || state.mode === 'updates') {
    return nothing;
  }
  // Clear "x" (item 4): slotted into the textfield's content-after; action-icon
  // renders it as a real, accessible button. Shown only when there's text —
  // toggled via the .hidden class so typing never rebuilds the textfield.
  const clearHidden = state.query ? '' : ' hidden';
  return html`<div class="search-row"><vscode-textfield id="search" placeholder="${
    state.mode === 'browse' ? 'Search artifacts…' : 'Search installed…'
  }" value="${state.query}"><vscode-icon slot="content-after" id="search-clear" class="clear-icon${clearHidden}" name="close" action-icon label="Clear search" title="Clear search" data-action="clear-search"></vscode-icon></vscode-textfield></div>`;
}

export function renderSidebarFilters(
  state: SidebarState,
  filter: CardFilter,
): TemplateResult | typeof nothing {
  if (state.phase !== 'ready') {
    return nothing;
  }
  // Updates: no filters. Project/Global: Kind chips. Browse: full filter row.
  if (state.mode === 'updates') {
    return nothing;
  }
  return state.mode === 'browse' ? renderFilters(filter) : renderInstalledFilters(state, filter);
}

export function renderSidebarResults(state: SidebarState, filter: CardFilter): TemplateResult {
  if (state.phase === 'no-grim') {
    return renderNoGrim();
  }
  if (state.phase === 'loading') {
    return renderLoading(state.defaultRegistry ?? null);
  }
  if (state.phase === 'error') {
    return html`<div class="error-state"><span class="codicon codicon-error"></span> ${state.error ?? 'Unknown error'}</div>`;
  }
  if (state.mode !== 'browse') {
    return renderInstalledResults(state, filter);
  }
  const filtered = filterCards(state.items, filter);
  const registries = registriesOf(state.items).length;
  const summary =
    filtered.length > 0
      ? html`<div class="result-summary">${filtered.length} result${filtered.length === 1 ? '' : 's'} in ${registries} ${registries === 1 ? 'registry' : 'registries'}</div>`
      : nothing;
  const body =
    filtered.length === 0
      ? renderEmpty(state)
      : html`${repeat(filtered, (c) => c.repo, (c) => renderCard(c))}`;
  return html`${summary}<div class="cards">${body}</div>`;
}

const SIDEBAR_TABS: ReadonlyArray<{ id: SidebarState['mode']; label: string }> = [
  { id: 'browse', label: 'BROWSE' },
  { id: 'updates', label: 'UPDATES' },
  { id: 'installed', label: 'INSTALLED' },
];

/** The internal tab bar (the merged single view replaces the old three native
 *  views). `state.mode` is the active tab; the Updates label carries the
 *  outdated count so it stays discoverable from any tab. Hidden on no-grim —
 *  there is nothing to switch between. */
export function renderSidebarTabs(state: SidebarState): TemplateResult | typeof nothing {
  if (state.phase === 'no-grim') {
    return nothing;
  }
  const outdated = state.installedItems.filter((c) => c.state === 'outdated').length;
  const tabs = SIDEBAR_TABS.map(({ id, label }) => {
    const count =
      id === 'updates' && outdated > 0
        ? html`<span class="tab-count">${outdated}</span>`
        : nothing;
    return html`<button class="tab${state.mode === id ? ' active' : ''}" data-action="set-tab" data-tab="${id}" aria-pressed="${state.mode === id}">${label}${count}</button>`;
  });
  return html`<div class="tabs sidebar-tabs">${tabs}</div>`;
}

/** The cached-catalog status line, rendered into its own bottom-pinned region
 *  (#sb-footer) so it never scrolls with results. Loading has its own footer. */
export function renderSidebarFooter(state: SidebarState): TemplateResult | typeof nothing {
  return state.phase === 'ready' || state.phase === 'error' ? renderFooter(state) : nothing;
}

export function renderSidebar(state: SidebarState, filter: CardFilter): TemplateResult {
  return html`${renderSidebarNotice(state)}${renderSidebarTabs(state)}${renderSidebarSearch(
    state,
  )}${renderSidebarFilters(state, filter)}${renderSidebarResults(state, filter)}${renderSidebarFooter(
    state,
  )}`;
}

// --- Details page ---

function railRow(label: string, value: unknown): TemplateResult {
  return html`<div class="rail-row"><span class="rail-label">${label}</span><span class="rail-value">${value}</span></div>`;
}

function statusCell(updateAvailable: boolean): TemplateResult {
  return updateAvailable
    ? html`<span class="status-inline"><span class="status-dot"></span>Update available</span>`
    : html`<span class="status-inline"><span class="codicon codicon-check ok-check"></span>Up to date</span>`;
}

function renderInstallationPanel(vm: DetailsVM): TemplateResult {
  if (vm.installs.length === 0) {
    return html`
<div class="rail-panel">
  <div class="rail-title">INSTALLATION</div>
  ${railRow(
    'Status',
    html`<span class="status-inline"><span class="status-dot muted"></span>Not installed</span>`,
  )}
  ${vm.kind === 'bundle' && vm.members.length > 0
    ? railRow('Unit', `${vm.members.length} artifacts, installed together`)
    : nothing}
</div>`;
  }
  const multi = vm.installs.length > 1;
  const panels = vm.installs.map((install, index) => {
    const rows: TemplateResult[] = [railRow('Status', statusCell(install.updateAvailable))];
    rows.push(
      railRow(
        'Installed',
        valueOr(install.version, (v) => html`<span class="mono">${v}</span>`),
      ),
    );
    if (install.updateAvailable && vm.latestVersion) {
      rows.push(railRow('Latest', html`<span class="mono">${vm.latestVersion}</span>`));
    }
    if (!multi) {
      rows.push(
        railRow(
          'Scope',
          install.scope === 'project'
            ? `Project${vm.scopes.projectName ? ` (${vm.scopes.projectName})` : ''}`
            : 'Global',
        ),
      );
    }
    rows.push(
      railRow(
        'Clients',
        install.clients.length > 0
          ? html`<span class="chip-list">${clientChips(install.clients)}</span>`
          : html`<span class="null-value">None</span>`,
      ),
    );
    const subheader = multi
      ? html`<div class="rail-subtitle${index > 0 ? ' rail-subtitle-divided' : ''}"><span class="codicon codicon-${install.scope === 'project' ? 'root-folder' : 'globe'}"></span>${scopeLabel(install.scope, vm.scopes.projectName)}</div>`
      : nothing;
    return html`<div class="rail-subsection">${subheader}${rows}</div>`;
  });
  const title = multi ? `INSTALLATIONS (${vm.installs.length})` : 'INSTALLATION';
  return html`<div class="rail-panel"><div class="rail-title">${title}</div>${panels}</div>`;
}

/** Members render as fully clickable boxes/rows: the whole container carries
 *  the open-details action + role="button"/tabindex when the member resolves to
 *  a repo (main.ts maps Enter/Space to a click); unresolved members stay inert
 *  plain text. Keeping the action on the container (not a nested button) avoids
 *  double-nested interactive elements. The four attributes are a closed set keyed
 *  on `repo` — bound inline via ifDefined at each call site (member-row/-box),
 *  since lit has no spliceable attribute fragment. */
function memberNameEl(name: string, clickable: boolean): TemplateResult {
  return html`<span class="member-name${clickable ? ' member-name-link' : ''}">${name}</span>`;
}

function renderContentsPanel(vm: DetailsVM): TemplateResult | typeof nothing {
  if (vm.kind !== 'bundle' || vm.members.length === 0) {
    return nothing;
  }
  const rows = vm.members.map(
    (m) =>
      html`<div class="member-row" data-action="${ifDefined(m.repo ? 'open-details' : undefined)}" data-repo="${ifDefined(m.repo ?? undefined)}" role="${ifDefined(m.repo ? 'button' : undefined)}" tabindex="${ifDefined(m.repo ? '0' : undefined)}"><span class="codicon codicon-${kindIcon(m.kind)} ${kindClass(m.kind)}"></span>${memberNameEl(m.name, m.repo !== null)}${m.version ? html`<span class="mono member-version">${m.version}</span>` : nothing}</div>`,
  );
  return html`<div class="rail-panel"><div class="rail-title">CONTENTS</div>${rows}</div>`;
}

function renderPackagePanel(vm: DetailsVM): TemplateResult {
  const repoPath = vm.repo.split('/').slice(1).join('/');
  const tags =
    vm.tags && vm.tags.length > 0
      ? html`<span class="chip-list rail-tags">${vm.tags.map(
          (t, i) => html`<span class="tag-chip mono${i >= 6 ? ' tag-overflow' : ''}">${t}</span>`,
        )}${vm.tags.length > 6 ? html`<button class="link-button tag-more" data-action="toggle-tags">+${vm.tags.length - 6} more</button>` : nothing}</span>`
      : null;
  return html`
<div class="rail-panel">
  <div class="rail-title">PACKAGE</div>
  ${railRow(
    'Registry',
    html`<span class="registry-cell"><span class="codicon codicon-globe"></span>${vm.registryHost}</span>`,
  )}
  ${railRow('Repository', html`<span class="mono">${repoPath}</span>`)}
  ${railRow('Tags', tags ?? html`<span class="null-value">Not provided</span>`)}
  ${railRow(
    'Published',
    valueOr(vm.published, (v) => formatDate(v)),
  )}
  ${railRow(
    'Revision',
    valueOr(vm.revision, (v) => html`<span class="mono">${v.slice(0, 7)}</span>`),
  )}
</div>`;
}

function renderResourcesPanel(vm: DetailsVM): TemplateResult | typeof nothing {
  if (!vm.sourceRepository && !vm.license) {
    return nothing;
  }
  const rows: TemplateResult[] = [];
  if (vm.sourceRepository) {
    rows.push(
      html`<div class="rail-link-row"><a href="#" class="resource-link" data-action="open" data-url="${vm.sourceRepository}"><span class="codicon codicon-github"></span><span class="resource-label">Source repository</span></a></div>`,
    );
  }
  // Text is wrapped in its own span (.resource-label) so hover-underline CSS
  // can target just the label — the icon and label are flex siblings inside
  // an inline-flex link, and decoration on the link itself paints under the
  // codicon glyph too.
  rows.push(
    html`<div class="rail-link-row">${
      vm.license
        ? html`<span class="resource-link static"><span class="codicon codicon-law"></span><span class="resource-label">License: ${vm.license}</span></span>`
        : html`<span class="null-value resource-null"><span class="codicon codicon-law"></span><span class="resource-label">License not provided</span></span>`
    }</div>`,
  );
  return html`<div class="rail-panel"><div class="rail-title">RESOURCES</div>${rows}</div>`;
}

/** Keyword chips are buttons: clicking one seeds the Browse search with that
 *  tag (item 2). The tag is escaped in markup and treated as untrusted when the
 *  host seeds the query. */
function renderTagsPanel(vm: DetailsVM): TemplateResult {
  const chips =
    vm.keywords && vm.keywords.length > 0
      ? html`<div class="chip-list">${vm.keywords.map(
          (k) =>
            html`<button class="keyword-chip" data-action="search-tag" data-tag="${k}" title="Search for ${k}">${k}</button>`,
        )}</div>`
      : html`<span class="null-value">No keywords</span>`;
  return html`<div class="rail-panel"><div class="rail-title">TAGS</div>${chips}</div>`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderDeprecationBanner(vm: DetailsVM): TemplateResult | typeof nothing {
  if (!vm.deprecated) {
    return nothing;
  }
  const replacement = vm.replacedBy
    ? html` — use <a href="#" data-action="open-details" data-repo="${vm.replacedBy}" class="mono">${vm.replacedBy}</a> instead`
    : nothing;
  const extra =
    vm.deprecated !== 'deprecated'
      ? html` <span class="deprecation-msg">${vm.deprecated}</span>`
      : nothing;
  return html`
<div class="deprecation-banner">
  <span class="codicon codicon-warning"></span>
  <span>This artifact is deprecated${replacement}. It can still be installed, but will not receive updates.${extra}</span>
</div>`;
}

/** Per-scope Install split button (item 2): primary Install for that scope,
 *  chevron opens "Install specific version…" (pickVersion with scope preselected).
 *  The nested `.scope-menu hidden` dropdown ships closed; the details webview
 *  toggles it open via its openScopeMenu state on re-render. */
function scopeInstallButton(vm: DetailsVM, scope: Scope): TemplateResult {
  return html`<div class="split-button sm"><button class="split-main" data-action="install" data-scope="${scope}">Install</button><button class="split-arrow" data-action="scope-menu" title="More install options"><span class="codicon codicon-chevron-down"></span></button><div class="scope-menu hidden"><button class="menu-item" data-action="pick-version" data-repo="${vm.repo}" data-scope="${scope}"><span class="menu-label">Install Version</span></button></div></div>`;
}

/** Per-scope Uninstall split button (design 2a gear-first rework): main
 *  uninstalls that scope, chevron opens "Switch to specific version…" — the
 *  pick-version flow doubles as downgrade/pin since installing an older tag
 *  overwrites the current one. Bundle-held installs can't be uninstalled
 *  directly, so the cell shows a plain "Bundle" nav button instead — it
 *  follows to the providing bundle's details (identity of all providing
 *  bundles lives in the tooltip via viaBundleTitle). */
function scopeUninstallButton(vm: DetailsVM, install: InstallVM): TemplateResult {
  if (install.viaBundles.length > 0) {
    // ponytail: multiple providing bundles open the first; a per-bundle
    // picker menu would need its own dropdown — add if that ceiling matters.
    return html`<button class="via-bundle-btn" data-action="open-details" data-repo="${install.viaBundles[0] ?? ''}" title="${viaBundleTitle(install.viaBundles)}">Bundle<span class="codicon codicon-package"></span></button>`;
  }
  return html`<div class="split-button sm"><button class="split-main" data-action="uninstall" data-kind="${install.kind}" data-name="${install.name}" data-scope="${install.scope}">Uninstall</button><button class="split-arrow" data-action="scope-menu" title="More options"><span class="codicon codicon-chevron-down"></span></button><div class="scope-menu hidden"><button class="menu-item" data-action="pick-version" data-repo="${vm.repo}" data-scope="${install.scope}"><span class="menu-label">Switch Version</span></button></div></div>`;
}

/** Per-scope Update split button (item 1): when a direct install is outdated,
 *  Update takes precedence over Uninstall on the one row button — main updates
 *  that scope, chevron opens "Switch to specific version…" (downgrade/pin) AND
 *  "Uninstall". Same geometry as the Install/Uninstall split buttons. */
function scopeUpdateButton(vm: DetailsVM, install: InstallVM): TemplateResult {
  return html`<div class="split-button sm"><button class="split-main" data-action="update" data-kind="${install.kind}" data-name="${install.name}" data-scope="${install.scope}">Update</button><button class="split-arrow" data-action="scope-menu" title="More options"><span class="codicon codicon-chevron-down"></span></button><div class="scope-menu hidden"><button class="menu-item" data-action="pick-version" data-repo="${vm.repo}" data-scope="${install.scope}"><span class="menu-label">Switch Version</span></button><button class="menu-item" data-action="uninstall" data-kind="${install.kind}" data-name="${install.name}" data-scope="${install.scope}"><span class="menu-label">Uninstall</span></button></div></div>`;
}

/** Row gear (design 2a gear-first rework): sits first in the actions cell on
 *  every row, installed or not, so the split button after it lands at the
 *  same x on both — opens the shared row menu (model.scopeRowMenuEntries). */
function scopeGear(entries: MenuEntry[]): TemplateResult | typeof nothing {
  // ponytail: the row gear is dormant when empty (every row but a via-bundle
  // outdated one now) — hidden here, but the renderer + scope-gear handler stay
  // for future per-row entries.
  if (entries.length === 0) {
    return nothing;
  }
  return html`<span class="scope-gear"><button class="icon-button" data-action="scope-gear" title="More actions"><span class="codicon codicon-gear"></span></button><div class="scope-menu hidden">${renderMenuEntries(entries)}</div></span>`;
}

function scopeRowShell(
  vm: DetailsVM,
  scope: Scope,
  divided: boolean,
  cells: unknown,
): TemplateResult {
  const pathLabel = scope === 'project' ? '.grimoire/' : '~/.grimoire';
  return html`
<div class="scope-row${divided ? ' scope-row-divided' : ''}">
  <span class="codicon codicon-${scope === 'project' ? 'root-folder' : 'globe'} scope-icon"></span>
  <span class="scope-id">
    <span class="scope-name">${scopeLabel(scope, vm.scopes.projectName)}</span>
    <span class="scope-path mono">${pathLabel}</span>
  </span>
  ${cells}
</div>`;
}

/** A scope row whose install state isn't known yet (skeleton, item 2): the same
 *  shell and column widths as a resolved row, with a spinner in the status cell,
 *  so the box holds its geometry and nothing shifts when the real state lands. */
function pendingScopeRow(vm: DetailsVM, scope: Scope, divided: boolean): TemplateResult {
  const cells = html`<span class="scope-version scope-status-muted"><span class="mono scope-ver"></span><span class="scope-glyph"><span class="codicon codicon-loading codicon-modifier-spin"></span></span><span>Checking…</span></span>
  <span class="scope-clients chip-list"></span>
  <span class="scope-actions"></span>`;
  return scopeRowShell(vm, scope, divided, cells);
}

/** A scope with no install: muted "Not installed" cell + gear (Copy repo path
 *  only) + the Install split button. */
function notInstalledScopeRow(vm: DetailsVM, scope: Scope, divided: boolean): TemplateResult {
  const cells = html`<span class="scope-version scope-status-muted"><span class="mono scope-ver"></span><span class="scope-glyph"><span class="status-dot muted"></span></span><span>Not installed</span></span>
  <span class="scope-clients chip-list"></span>
  <span class="scope-actions">${scopeGear(scopeRowMenuEntries(null))}${scopeInstallButton(vm, scope)}</span>`;
  return scopeRowShell(vm, scope, divided, cells);
}

/** An installed scope: version cell, clients, gear (Update when outdated +
 *  Copy repo path) + the Uninstall split button — same shape as the
 *  not-installed row so the two align (design 2a gear-first rework). */
function installedScopeRow(vm: DetailsVM, install: InstallVM, divided: boolean): TemplateResult {
  const versionInfo = install.updateAvailable
    ? html`<span class="mono scope-ver">${install.version ?? ''}</span><span class="scope-glyph"><span class="status-dot"></span></span><span class="scope-update-hint">${vm.latestVersion ? `${vm.latestVersion} available` : 'update available'}</span>`
    : html`<span class="mono scope-ver">${install.version ?? vm.latestVersion ?? ''}</span><span class="scope-glyph"><span class="codicon codicon-check ok-check"></span></span><span class="scope-ok-hint">up to date</span>`;
  // Update takes precedence on the one row button for a direct (non-bundle)
  // outdated install; via-bundle rows always show the Bundle nav button (its
  // update path stays in the gear), and up-to-date rows show Uninstall.
  const button =
    install.updateAvailable && install.viaBundles.length === 0
      ? scopeUpdateButton(vm, install)
      : scopeUninstallButton(vm, install);
  const cells = html`<span class="scope-version">${versionInfo}</span>
  <span class="scope-clients chip-list">${clientChips(install.clients)}</span>
  <span class="scope-actions">${scopeGear(scopeRowMenuEntries(install))}${button}</span>`;
  return scopeRowShell(vm, install.scope, divided, cells);
}

/** Details header install area: both scope rows always render — Project only
 *  when a workspace is open, Global always. Each row carries its own in-box
 *  state (installed version / "Not installed"); the redundant status caption
 *  that used to sit below the box is gone. */
function renderHeaderActions(vm: DetailsVM): TemplateResult {
  const scopes: Scope[] = vm.scopes.projectOpen ? ['project', 'global'] : ['global'];
  const rows = scopes.map((scope, index) => {
    if (vm.scopesPending) {
      return pendingScopeRow(vm, scope, index > 0);
    }
    const install = vm.installs.find((i) => i.scope === scope);
    return install
      ? installedScopeRow(vm, install, index > 0)
      : notInstalledScopeRow(vm, scope, index > 0);
  });
  return html`<div class="scope-box">${rows}</div>`;
}

/** Placeholder rail panels at roughly the final panel heights, so the 300px
 *  column holds its shape while the real INSTALLATION/PACKAGE/… panels load
 *  (item 2) instead of the rail popping in and shoving the layout. */
function renderRailSkeleton(): TemplateResult {
  const line = (w: string): TemplateResult => html`<div class="rail-skeleton-line ${w}"></div>`;
  const block = (rows: TemplateResult[]): TemplateResult =>
    html`<div class="rail-panel"><div class="rail-skeleton-title"></div>${rows}</div>`;
  return html`${block([line('w80'), line('w60'), line('w70')])}${block([line('w70'), line('w50')])}`;
}

/** A bundle member as a clickable "What's inside" box (CONTENTS tab, item 5). */
function memberBox(m: BundleMemberVM): TemplateResult {
  return html`
<div class="member-box" data-action="${ifDefined(m.repo ? 'open-details' : undefined)}" data-repo="${ifDefined(m.repo ?? undefined)}" role="${ifDefined(m.repo ? 'button' : undefined)}" tabindex="${ifDefined(m.repo ? '0' : undefined)}">
  ${kindTile(m.kind, 'member-tile')}
  <div class="member-main">
    <div class="member-head">${memberNameEl(m.name, m.repo !== null)}${m.version ? html`<span class="mono member-version">${m.version}</span>` : nothing}</div>
    ${m.description ? html`<div class="member-desc">${m.description}</div>` : nothing}
  </div>
</div>`;
}

/**
 * Tiny pure JSON syntax highlighter for the CONTENTS tab (item 6): emits
 * <span>s tagged by token kind (styled with VS Code debug-token colors). Every
 * chunk — token text and the gaps between tokens alike — goes through esc(), so
 * hostile string contents such as `"</span><script>"` stay inert. The result is
 * self-generated, already-escaped markup, so {@link renderJsonBlock} injects it
 * via unsafeHTML.
 */
export function highlightJson(json: string): string {
  const token =
    /("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}[\],:])/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = token.exec(json)) !== null) {
    out += esc(json.slice(last, m.index));
    last = token.lastIndex;
    if (m[1] !== undefined) {
      // A string is a key when the next non-space character is a colon.
      const isKey = /^\s*:/.test(json.slice(token.lastIndex));
      out += `<span class="${isKey ? 'json-key' : 'json-string'}">${esc(m[1])}</span>`;
    } else if (m[2] !== undefined) {
      out += `<span class="json-number">${esc(m[2])}</span>`;
    } else if (m[3] !== undefined) {
      out += `<span class="json-boolean">${esc(m[3])}</span>`;
    } else if (m[4] !== undefined) {
      out += `<span class="json-null">${esc(m[4])}</span>`;
    } else {
      out += `<span class="json-punct">${esc(m[5] ?? '')}</span>`;
    }
  }
  out += esc(json.slice(last));
  return out;
}

/** Full-width syntax-highlighted JSON block for the CONTENTS tab (item 6). */
function renderJsonBlock(json: string): TemplateResult {
  // highlightJson output is self-generated, fully esc()-escaped <span> markup
  // (token text and inter-token gaps alike), so unsafeHTML injects it verbatim
  // without a second escaping pass.
  return html`<pre class="json-code"><code>${unsafeHTML(highlightJson(json))}</code></pre>`;
}

/** CONTENTS tab body (item 5): the artifact's own content. Skills/rules/agents
 *  fill an #md-contents element (markdown, client-side); mcp shows its JSON
 *  descriptor; bundles show the member boxes plus the raw manifest. */
function renderContentsBody(vm: DetailsVM): TemplateResult {
  if (vm.kind === 'bundle') {
    const boxes = vm.members.map(memberBox);
    const manifest = vm.contentJson
      ? html`<div class="contents-manifest"><div class="contents-manifest-label">Manifest</div>${renderJsonBlock(vm.contentJson)}</div>`
      : nothing;
    return html`${boxes}${manifest}`;
  }
  if (vm.kind === 'mcp' && vm.contentJson !== null) {
    return renderJsonBlock(vm.contentJson);
  }
  return html`<div class="md-body" id="md-contents"></div>`;
}

/** Header version chip (item 4): sits last in the badge row so its late
 *  arrival never displaces the name/kind/registry to its left. When the version
 *  is not yet known (skeleton), a same-size placeholder reserves the slot so the
 *  real chip fills it without reflow. */
function headerVersionBadge(vm: DetailsVM): TemplateResult | typeof nothing {
  const version = concreteVersion(vm.installs[0]?.version, vm.latestVersion);
  if (version) {
    return html`<span class="header-version mono">${version}</span>`;
  }
  return vm.loading
    ? html`<span class="header-version header-version-pending" aria-hidden="true"></span>`
    : nothing;
}

const REVALIDATE_ICON: Record<RevalidateState, TemplateResult> = {
  checking: html`<span class="codicon codicon-loading codicon-modifier-spin"></span>`,
  done: html`<span class="codicon codicon-check"></span>`,
  failed: html`<span class="codicon codicon-warning"></span>`,
};

/** Inner markup for the top-right background-revalidate indicator; `nothing`
 *  clears it. On 'failed' the icon becomes an actionable button carrying the
 *  concrete error as its (escaped) title; checking/done stay inert. */
export function revalidateIndicator(
  state: RevalidateState | null,
  message?: string,
): TemplateResult | typeof nothing {
  if (state === null) {
    return nothing;
  }
  if (state === 'failed') {
    const title = message ?? 'Refresh failed — showing cached data';
    return html`<span class="revalidate-icon" data-action="revalidate-error" title="${title}">${REVALIDATE_ICON.failed}</span>`;
  }
  return html`<span class="revalidate-icon">${REVALIDATE_ICON[state]}</span>`;
}

/** Empty host for {@link revalidateIndicator}; main.ts fills it per message. Lives
 *  in every details render so it survives root re-renders (fixed, top-right). */
const revalidateHost = html`<div class="revalidate-indicator" id="revalidate-indicator"></div>`;

export function renderDetails(vm: DetailsVM): TemplateResult {
  const icon = vm.logoUri
    ? html`<div class="header-icon"><img class="header-logo" src="${vm.logoUri}" alt=""/></div>`
    : kindTile(vm.kind, 'header-icon');
  const nameClass = vm.deprecated ? 'header-name struck' : 'header-name';
  // While an action runs, or before the real VM has landed, the header actions
  // are inert (CSS) — this stops a double click starting a second grim command
  // (e.g. a duplicate `grim init`) and stops clicks on a cached/stale loading
  // snapshot from firing against the wrong artifact.
  const header = html`
<div class="details-header${vm.busy ? ' busy' : ''}${vm.loading ? ' loading' : ''}">
  ${icon}
  <div class="header-main">
    <div class="header-title">
      <span class="${nameClass}">${vm.name}</span>
      ${kindBadge(vm.kind)}
      <span class="header-registry"><span class="codicon codicon-globe"></span>${vm.registryHost}</span>
      ${headerVersionBadge(vm)}
    </div>
    <div class="header-repo-row">
      <span class="header-repo mono" data-action="copy" data-repo="${vm.repo}" title="Copy repo path">${vm.repo}</span>
      <button class="header-share" data-action="copy-share" data-repo="${vm.repo}" title="Copy share link"><span class="codicon codicon-link"></span></button>
      ${vm.isPreview
        ? html`<button class="header-share header-pin" data-action="promote" title="Keep open"><span class="codicon codicon-pin"></span></button>`
        : nothing}
    </div>
    <div class="header-desc">${vm.description ?? ''}</div>
    ${renderHeaderActions(vm)}
  </div>
</div>`;
  // Skeleton (item 2): the FULL structure renders instantly — header with scope
  // boxes, the tab strip, and the 300px rail with placeholder panels. Header
  // geometry and the rail column are reserved up front (the header markup is
  // identical to the resolved render — no flash); the tab strip pre-renders
  // DETAILS + CONTENTS + CHANGELOG (DETAILS/CHANGELOG disabled, since their
  // presence is unknown yet) so the strip doesn't reflow when the real VM lands,
  // and rail placeholder heights are approximate, not exact matches.
  // Label is README; data-tab id stays 'details' internally (renaming it would
  // ripple to main.ts panel ids + #md-details + CSS for no user-visible gain).
  const disabledDetailsTab = html`<button class="tab" data-tab="details" disabled title="No README available">README</button>`;
  const disabledChangelogTab = html`<button class="tab" data-tab="changelog" disabled title="No changelog available">CHANGELOG</button>`;
  if (vm.loading) {
    return html`${revalidateHost}${header}
${renderDeprecationBanner(vm)}
<div class="details-body">
  <div class="reading-column"><div class="reading-content">
    <div class="tabs">${disabledDetailsTab}<button class="tab active" data-tab="contents">CONTENTS</button>${disabledChangelogTab}</div>
    <div class="tab-panel" id="panel-contents"><div class="details-loading"><vscode-progress-ring></vscode-progress-ring></div></div>
  </div></div>
  <div class="right-rail">${renderRailSkeleton()}</div>
</div>`;
  }
  // Tab semantics (item 5): DETAILS always leads the strip, CHANGELOG always
  // closes it. With their content they are enabled; without, they render
  // disabled (grayed out, not clickable — see main.ts's click guard and the
  // native title tooltip). DETAILS active by default when it has a README, else
  // CONTENTS. CONTENTS is the artifact's own content and always present.
  const hasDetails = vm.readmeMarkdown !== null;
  const hasChangelog = vm.changelogMarkdown !== null;
  const first = hasDetails ? 'details' : 'contents';
  const tab = (id: string, label: string): TemplateResult =>
    html`<button class="tab${first === id ? ' active' : ''}" data-tab="${id}">${label}</button>`;
  const tabs = html`${hasDetails ? tab('details', 'README') : disabledDetailsTab}${tab('contents', 'CONTENTS')}${hasChangelog ? tab('changelog', 'CHANGELOG') : disabledChangelogTab}`;
  const panel = (id: string, active: boolean, inner: unknown): TemplateResult =>
    html`<div class="tab-panel${active ? '' : ' hidden'}" id="panel-${id}">${inner}</div>`;
  const panels = html`${hasDetails ? panel('details', first === 'details', html`<div class="md-body" id="md-details"></div>`) : nothing}${panel('contents', first === 'contents', renderContentsBody(vm))}${hasChangelog ? panel('changelog', false, html`<div class="md-body" id="md-changelog"></div>`) : nothing}`;
  // A cold fetch failure (no content) surfaces in-body, inside the reading
  // column where the loading spinner sat — content area only, nothing above the
  // header shifts. Warm revalidate failures never repost a VM (the cached paint
  // stays; the top-right indicator + notification cover them), so vm.error here
  // always means a contentless cold load.
  const readingBody = vm.error
    ? html`<div class="error-state"><span class="codicon codicon-error"></span> ${vm.error}</div>`
    : html`<div class="tabs">${tabs}</div>
    ${panels}`;
  return html`${revalidateHost}
${header}
${renderDeprecationBanner(vm)}
<div class="details-body">
  <div class="reading-column"><div class="reading-content">
    ${readingBody}
  </div></div>
  <div class="right-rail">
    ${renderInstallationPanel(vm)}
    ${renderContentsPanel(vm)}
    ${renderPackagePanel(vm)}
    ${renderResourcesPanel(vm)}
    ${renderTagsPanel(vm)}
  </div>
</div>`;
}
