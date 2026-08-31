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
import { createMarkdown } from './markdown';
import { contactUrl } from './model';
import type {
  BundleMemberVM,
  CardVM,
  DetailsVM,
  InstallVM,
  RatingVM,
  RevalidateState,
  Scope,
  SidebarState,
  VoteState,
} from './protocol';
import {
  CardFilter,
  DEFAULT_FILTER,
  DEFAULT_VIEW,
  KIND_ICONS,
  avatarTint,
  buildTree,
  cardMenuEntries,
  clientDriftTooltip,
  cardVersion,
  concreteVersion,
  effectiveInstall,
  filterCards,
  groupCards,
  groupKeyFor,
  hasClientDrift,
  hasOutputsPending,
  hasUpdate,
  installedCards,
  monogram,
  normalizeKind,
  outputsPendingTooltip,
  registryCount,
  registryLabel,
  relativeTime,
  scopeRowMenuEntries,
  viaBundleTitle,
  type CardGroup,
  type SortMode,
  type MenuEntry,
  type TreeNode,
  type ViewOptions,
} from './model';

/** Expanded group/tree node ids. Empty when the caller has none (the string
 *  renderers and every pre-view-modes call site). */
export type ExpandedNodes = ReadonlySet<string>;

const NONE_EXPANDED: ExpandedNodes = new Set<string>();

// Shared markdown-it for inline bits rendered in the templates (e.g. the header
// description). html:false keeps raw HTML inert; renderInline emits no <p>
// wrapper — inline constructs only (emphasis, code spans, links), which is all a
// one-line description should carry. Same instance the details bodies use.
const md = createMarkdown();

/** Header description rendered as inline markdown. markdown-it output is
 *  html:false (inert) so unsafeHTML injects it like the details bodies do;
 *  linkify/emphasis/code spans render, raw HTML stays escaped. */
function headerDesc(description: string | null): TemplateResult | string {
  return description ? html`${unsafeHTML(md.renderInline(description))}` : '';
}

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
 *  the kind-tinted codicon tile. lit escapes the data: URI like any binding.
 *  `extra` adds a size modifier (the compact row and tree leaves pass 'sm');
 *  empty — the card default — renders exactly the markup it always has. */
function cardTile(card: CardVM, extra = ''): TemplateResult {
  const suffix = extra ? ` ${extra}` : '';
  return card.logoUri
    ? html`<div class="kind-tile has-logo ${kindClass(card.kind)}${suffix}"><img class="card-logo" src="${card.logoUri}" alt=""/></div>`
    : kindTile(card.kind, extra);
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

/**
 * Invariant R-3 at the pixel: what each of the three vote states LOOKS like.
 *
 * The distinction that matters is `unknown` vs `not-voted`, and it is carried
 * by the label and by `aria-pressed`, not by colour:
 *
 * | state | pressed | says |
 * |---|---|---|
 * | `voted` | `true` | "You upvoted this — click to retract" |
 * | `not-voted` | `false` | "You have not upvoted this" |
 * | `unknown` | *omitted* | "Upvote this artifact" — claims nothing |
 *
 * `unknown` omits `aria-pressed` rather than sending `false`, because `false`
 * is a screen-reader announcing "not pressed" — the exact "you have not voted"
 * claim C-019 forbids. There is no fourth branch and no boolean anywhere in
 * here: a `!voted` would have to invent one of these three answers.
 */
function voteAffordance(vote: VoteState, up: number): TemplateResult {
  const voted = vote === 'voted';
  const label = voted
    ? 'You upvoted this — click to retract'
    : vote === 'not-voted'
      ? 'You have not upvoted this'
      : 'Upvote this artifact';
  return html`<button
    class="rating-vote${voted ? ' voted' : ''}${vote === 'unknown' ? ' unknown' : ''}"
    data-action="vote"
    data-remove="${voted ? 'true' : 'false'}"
    aria-pressed="${ifDefined(vote === 'unknown' ? undefined : String(voted))}"
    title="${label}"
    aria-label="${label}"
  ><span class="codicon codicon-arrow-up"></span><span class="rating-count">${up}</span></button>`;
}

/** The browse card / compact row rating: the aggregate count and nothing else.
 *  Neutral by construction — the sidebar has no forge identity, so there is no
 *  vote state to claim, exactly as C-019 requires of the prerendered site. */
function ratingBadge(rating: RatingVM | null | undefined): TemplateResult | typeof nothing {
  if (!rating) {
    return nothing;
  }
  return html`<span class="rating-badge" title="${rating.up} ${rating.up === 1 ? 'upvote' : 'upvotes'}"><span class="codicon codicon-arrow-up"></span>${rating.up}</span>`;
}

/** The RATING rail panel. Omitted entirely on an unrated row — there is no
 *  thread to link and nothing to vote on, and an empty panel is not a zero
 *  (this repo's "empty panels are omitted" rule and S-002 agree). */
function renderRatingPanel(vm: DetailsVM): TemplateResult | typeof nothing {
  const rating = vm.rating;
  if (!rating) {
    return nothing;
  }
  // The link is grim's `url`, verbatim. The extension constructs no forge URL,
  // so an index that publishes a different forge simply works.
  const thread = html`<button class="link-button" data-action="open" data-url="${rating.url}">Open discussion</button>`;
  return html`
<div class="rail-panel">
  <div class="rail-title">RATING</div>
  ${railRow(
    'Upvotes',
    vm.canVote
      ? voteAffordance(rating.vote, rating.up)
      : html`<span class="rating-badge"><span class="codicon codicon-arrow-up"></span>${rating.up}</span>`,
  )}
  ${railRow('Thread', thread)}
</div>`;
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
 *  MenuEntry.data has a CLOSED key set (repo/scope/kind/name/replacedBy — see model.ts), so
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
    return html`<button class="menu-item" data-action="${entry.action}" data-repo="${ifDefined(d.repo)}" data-scope="${ifDefined(d.scope)}" data-kind="${ifDefined(d.kind)}" data-name="${ifDefined(d.name)}" data-replaced-by="${ifDefined(d.replacedBy)}">${entry.label}${hint}</button>`;
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
  /** Status did not load: drop the row's install/update affordance rather than
   *  render "Install" off an empty install list (see SidebarState). */
  installStateUnknown?: boolean;
}

/** Client-drift badge for an installed scope row (Installed tab): shown iff
 *  the install's clients_missing/clients_extra carry any entries — array
 *  non-emptiness is itself the explicit-clients signal, so no other gating. */
function clientDriftBadge(install: InstallVM | undefined): TemplateResult | typeof nothing {
  if (!install || !hasClientDrift(install)) {
    return nothing;
  }
  return html`<span class="drift-badge" title="${clientDriftTooltip(install)}"><span class="codicon codicon-warning"></span>Client drift</span>`;
}

/** Pending-outputs badge for an installed scope row (Installed tab): shown iff
 *  grim reports outputs an install would still write. Info, never warning — the
 *  artifact is installed and intact, and under autodetect this fires simply
 *  because another tool created a client's marker directory. */
function pendingBadge(install: InstallVM | undefined): TemplateResult | typeof nothing {
  if (!install || !hasOutputsPending(install)) {
    return nothing;
  }
  return html`<span class="pending-badge" title="${outputsPendingTooltip(install)}"><span class="codicon codicon-info"></span>Install incomplete</span>`;
}

export function renderCard(card: CardVM, options: CardVariant = {}): TemplateResult {
  const variant = options.variant ?? 'browse';
  const deprecatedClass = card.state === 'deprecated' ? ' deprecated' : '';
  // The INSTALLED version when there is one (see cardVersion) — a version
  // switch has to be visible here, not only in the details panel.
  const shown = cardVersion(card);
  const version = shown ? html`<span class="version mono">${shown}</span>` : nothing;
  // Deprecation on a card is styling only — struck-through, dimmed name (the
  // .card.deprecated rule). The message itself is a tooltip here and a banner
  // on the details view; a coloured warning line per card made a browse list of
  // them unreadable.
  const title = html`
    <div class="card-title">
      <span class="card-name" title="${ifDefined(card.deprecated ?? undefined)}">${card.name}</span>
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
    body = html`${title}
    <div class="card-meta">${extras}${clientChips(install?.clients ?? [])}${clientDriftBadge(install)}${pendingBadge(install)}
      <span class="card-actions"><span class="codicon codicon-check installed-check" title="Installed"></span><button class="icon-button" data-action="menu" title="Manage"><span class="codicon codicon-gear"></span></button></span>
    </div>`;
  } else {
    const description = html`<div class="card-desc">${card.description ?? ''}</div>`;
    // Private registries (a stored credential) get a lock glyph before the
    // host; the meta line shows host + first org segment (design html:227/277).
    const lock = card.privateRegistry
      ? html`<span class="codicon codicon-lock registry-lock"></span>`
      : nothing;
    body = html`${title}${description}
    <div class="card-meta">
      <span class="registry mono">${lock}${registryLabel(card.repo)}</span>
      ${ratingBadge(card.rating)}
      <span class="card-actions">${options.installStateUnknown ? nothing : cardAction(card)}</span>
    </div>`;
  }
  return html`
<div class="card${deprecatedClass}" data-repo="${card.repo}">
  ${cardTile(card)}
  <div class="card-body">${body}</div>
</div>`;
}

// --- Compact rows, group headers, tree (the view modes) ---

/** Indent class per tree level — CSP blocks inline style, so depth is a class
 *  (see renderLoading's skeleton widths for the same constraint). Deeper than
 *  the last class simply stops indenting rather than falling off the sidebar. */
function depthClass(depth: number): string {
  return `d${Math.min(depth, 5)}`;
}

/** The trailing slot on a compact row / tree leaf. One fixed-width box whose
 *  CONTENT is decided by state — never an affordance that appears on hover, so
 *  a row never reflows under the cursor:
 *
 *  | state | slot |
 *  |---|---|
 *  | install state unknown | empty (width reserved — we claim nothing) |
 *  | update available | Update button |
 *  | grim state modified/missing | warning glyph, no action (details explains) |
 *  | outputs pending | info glyph, no action (the repair is scope-wide) |
 *  | installed, clean | a dot — NOT a button: there is nothing to do here |
 *  | not installed | Install button |
 *
 *  The modified/missing row is the first surface in the extension to read
 *  {@link InstallVM.state}; rowState() collapses both into 'installed'. Pending
 *  ranks directly above installed, matching grim's own badge order — an update
 *  and real drift both outrank it, because it is a hint and they are not. */
function rowSlot(card: CardVM, installStateUnknown: boolean): TemplateResult {
  if (installStateUnknown) {
    return html`<span class="row-slot"></span>`;
  }
  const target = card.installs.find((i) => i.updateAvailable);
  if (target) {
    const to = card.latestVersion ? ` to ${card.latestVersion}` : '';
    return html`<span class="row-slot"><button class="row-action update" data-action="update" data-kind="${target.kind}" data-name="${target.name}" data-scope="${target.scope}" title="Update${to}"><span class="codicon codicon-sync"></span></button></span>`;
  }
  const drifted = card.installs.find((i) => i.state === 'modified' || i.state === 'missing');
  if (drifted) {
    const title =
      drifted.state === 'modified'
        ? 'Installed files were modified locally'
        : 'Installed files are missing';
    return html`<span class="row-slot"><span class="row-warn codicon codicon-warning" title="${title}"></span></span>`;
  }
  const pending = card.installs.find((i) => hasOutputsPending(i));
  if (pending) {
    return html`<span class="row-slot"><span class="row-pending codicon codicon-info" title="${outputsPendingTooltip(pending)}"></span></span>`;
  }
  const install = effectiveInstall(card.installs);
  if (install) {
    return html`<span class="row-slot"><span class="row-dot codicon codicon-circle-filled" title="Installed (${install.scope === 'project' ? 'Project' : 'Global'})"></span></span>`;
  }
  return html`<span class="row-slot"><button class="row-action" data-action="install" data-repo="${card.repo}" title="Install"><span class="codicon codicon-cloud-download"></span></button></span>`;
}

export interface RowOptions {
  installStateUnknown?: boolean;
  /** Tree leaves indent by level; omitted in the flat/grouped list. */
  depth?: number;
}

/** The compact (22px) row: the same CardVM the card renders, one line of it.
 *  Carries `data-repo` like the card does, so open-details, the double-click
 *  promote and the right-click menu all work off the shared row selector. */
export function renderCompactRow(card: CardVM, options: RowOptions = {}): TemplateResult {
  const leaf = options.depth === undefined ? '' : ` tree-leaf ${depthClass(options.depth)}`;
  const deprecated = card.state === 'deprecated' ? ' deprecated' : '';
  const shown = cardVersion(card);
  const version = shown ? html`<span class="row-version mono">${shown}</span>` : nothing;
  const title = card.deprecated ?? card.description ?? undefined;
  // In the tree the row IS a tree item; in the flat/grouped list it is just a
  // row, and claiming treeitem outside a tree would be a lie to the reader.
  const role = options.depth === undefined ? undefined : 'treeitem';
  // Leading column is the LOGO — publisher identity is what the eye lands on
  // first in a dense list — and it is a fixed box even when the artifact has
  // none, so every name starts at the same x. The trailing cluster reads in
  // scan order: gear, kind, state. Both glyph columns render bare; the card's
  // tinted tile background is a card affordance, and at 16px in a 22px row it
  // reads as a box around a smudge.
  // No logo → a monogram chip, tinted by a stable hash of the repo. The kind
  // glyph is NOT the fallback here the way it is on a card: it moved to the
  // trailing cluster, so reusing it would put the same icon twice in one row.
  const logo = card.logoUri
    ? html`<span class="row-logo"><img src="${card.logoUri}" alt=""/></span>`
    : html`<span class="row-logo monogram avatar-${avatarTint(card.repo)}" aria-hidden="true">${monogram(card.name)}</span>`;
  // Same data-action the card's gear uses, so it opens the same shared menu off
  // the row's data-repo. Dropped when install state is unknown, for the reason
  // the card drops its whole action cluster: every entry in that menu is a
  // claim about what is installed.
  const gear = options.installStateUnknown
    ? nothing
    : html`<button class="row-action row-gear" data-action="menu" title="Manage"><span class="codicon codicon-gear"></span></button>`;
  // The trailing cluster is ONE box (margin-left:auto in CSS), not three loose
  // siblings: the name shrinks to its text so the version can sit beside it like
  // it does on a card, and a row with no version must still hold the same right
  // edge as its neighbours — an auto margin on the version itself would collapse
  // exactly on those rows.
  const trailing = html`<span class="row-trailing">${gear}${kindTile(card.kind, 'sm')}${rowSlot(card, options.installStateUnknown === true)}</span>`;
  return html`<div class="compact-row${leaf}${deprecated}" data-repo="${card.repo}" role="${ifDefined(role)}" title="${ifDefined(title)}">${logo}<span class="row-name">${card.name}</span>${version}${trailing}</div>`;
}

function twisty(expanded: boolean): TemplateResult {
  return html`<span class="twisty codicon codicon-chevron-${expanded ? 'down' : 'right'}"></span>`;
}

function registryMarks(node: {
  private?: boolean;
  isDefaultRegistry?: boolean;
}): TemplateResult | typeof nothing {
  const lock = node.private
    ? html`<span class="codicon codicon-lock group-lock" title="Private registry"></span>`
    : nothing;
  const badge = node.isDefaultRegistry
    ? html`<span class="codicon codicon-star-empty group-default" title="Default registry"></span>`
    : nothing;
  // Wrapped, and each mark boxed to the same 18px as a leaf row's .row-slot:
  // the trailing column has to line up between a group header and the rows
  // under it, and a mark left to find the padding edge on its own does not.
  return lock === nothing && badge === nothing
    ? nothing
    : html`<span class="group-marks">${lock}${badge}</span>`;
}

function groupHeader(group: CardGroup, expanded: boolean): TemplateResult {
  return html`<button class="group-header" data-action="toggle-node" data-node="${group.id}" aria-expanded="${expanded}">${twisty(expanded)}<span class="group-label">${group.label}</span><span class="group-count">${group.cards.length}</span>${registryMarks(group)}</button>`;
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
    const icon =
      id === 'all' ? nothing : html`<span class="codicon codicon-${kindIcon(id)}"></span>`;
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

function renderFooter(state: SidebarState): TemplateResult {
  const registries = registryCount(state);
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
  return html`<div class="footer"><span class="codicon codicon-cloud"></span><span>${synced}</span>${suffix}</div>${footerWarning(state)}`;
}

/** Its own line under the sync timestamp: grim answered the search but warned
 *  while doing it — a source it could not read was dropped, and it still exited
 *  0, so the rows above are a subset of the catalog by an unknown amount and
 *  nothing else on screen says so.
 *
 *  A click opens the output channel, which is the only place the dropped source
 *  is named — the search envelope names no failure, so grim's stderr is all
 *  there is to point at.
 *
 *  It does not blink: {@link SidebarState.catalogIncomplete} is a last-known
 *  verdict stamped onto every post, including the `phase:'loading'` one that
 *  opens the next round, and only a search that SUCCEEDS with no warning takes
 *  it down. A refetch in flight is not evidence the registry came back. */
function footerWarning(state: SidebarState): TemplateResult | typeof nothing {
  if (state.catalogIncomplete !== true) {
    return nothing;
  }
  return html`<button
  class="footer-warning"
  data-action="show-output"
  title="grim could not read every registry — these results may be missing artifacts. Click to see which."
><span class="codicon codicon-warning"></span>Incomplete results</button>`;
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
  const registries = registryCount(state) || 1;
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

function renderLoading(): TemplateResult {
  // Fade is applied via .skeleton-row-N classes — inline style= is blocked by
  // the webview CSP (style-src is nonce/cspSource only). Line widths vary per
  // row (design html:333) so the skeleton doesn't read as four clones. The
  // "Refreshing…" line is NOT rendered here — it lives in the pinned #sb-footer
  // region (renderSidebarFooter), never inside this scrollable skeleton block
  // (item 1: a loading footer embedded here sits wherever the short skeleton
  // ends, which visually detaches it from the view's bottom edge until the
  // first real footer lands).
  const skeleton = (w1: string, w2: string, w3: string, fade: string): TemplateResult => html`
  <div class="skeleton-row${fade ? ` ${fade}` : ''}">
    <div class="skeleton-tile"></div>
    <div class="skeleton-lines"><div class="skeleton-line ${w1}"></div><div class="skeleton-line thin ${w2}"></div><div class="skeleton-line thin ${w3}"></div></div>
  </div>`;
  return html`<vscode-progress-bar></vscode-progress-bar>${skeleton('w55', 'w92', 'w70', '')}${skeleton('w44', 'w88', 'w62', 'skeleton-row-2')}${skeleton('w60', 'w80', 'w74', 'skeleton-row-3')}${skeleton('w50', 'w85', 'w58', 'skeleton-row-4')}`;
}

/** The "Refreshing from <host>…" line. Standalone so a background refresh over
 *  an already-painted list swaps only the footer while the cards stay put.
 *  Falls back to a plain "Refreshing…" when the registry host is not known
 *  yet (first refresh of a session) — never an empty footer. */
export function renderRefreshingFooter(defaultRegistry: string | null): TemplateResult {
  return html`<div class="footer loading-footer"><span class="codicon codicon-sync"></span><span>${
    defaultRegistry ? `Refreshing from ${defaultRegistry}…` : 'Refreshing…'
  }</span></div>`;
}

/** Workspace-level notice slot at the very top of the view, ABOVE the tab bar
 *  (its own #sb-notice region in main.ts) — normal flow, never overlaying the
 *  results. Notification look (VS Code notification tokens + info icon), not
 *  the old blockquote-style box. Self-gating: no-grim and first-load states
 *  post no snapshot, so projectOpen is false and nothing renders. Design's
 *  init-offer pattern (mockup 3c) is a full-panel replacement in the Settings
 *  view, which has nothing else to show alongside it; the sidebar always has
 *  the global catalog fallback showing beneath this notice (item 3), so it
 *  stays this compact banner rather than displacing real results — button
 *  copy/emphasis still matches 3c ("Initialize Project Config", primary). */
export function renderSidebarNotice(state: SidebarState): TemplateResult | typeof nothing {
  // A restored round paints cards that look exactly like fresh ones, so this
  // thin bar is the only thing saying grim is still answering behind them. It
  // rides the notice region because that is the one render root above the tabs
  // — the same element the loading skeleton uses (renderLoading).
  const refreshing =
    state.stale === true ? html`<vscode-progress-bar></vscode-progress-bar>` : nothing;
  // Install state unknown outranks the init offer: browsing still works, but
  // nothing on screen can be trusted to say what is installed, and the offer to
  // create a grimoire.toml would be answering the wrong question.
  if (state.installStateUnknown !== undefined) {
    // "Install grim" only when the extension can actually replace the resolved
    // binary: a too-old grim it manages ('bundled') or that is absent
    // ('missing'). A too-old grim on PATH/setting, or any non-too-old failure,
    // would keep being preferred by resolveExecutable, so a download changes
    // nothing — offer "Show grim Info" (diagnostics) instead of a no-op loop.
    const canInstall =
      state.installStateUnknownReason === 'too-old' &&
      (state.installStateUnknownOrigin === 'bundled' ||
        state.installStateUnknownOrigin === 'missing');
    const remedy = canInstall
      ? html`<vscode-button class="sm" data-action="install-grim">Install grim</vscode-button>`
      : state.installStateUnknownReason !== undefined
        ? html`<vscode-button class="sm secondary" data-action="show-grim-info">Show grim Info</vscode-button>`
        : nothing;
    // grim's raw message and our sentence are two separate statements — one
    // text node ran them together ("…'--check' found Install state is…").
    return html`${refreshing}
<div class="init-notification">
  <span class="codicon codicon-warning init-icon"></span>
  <div class="init-body">
    <span>${state.installStateUnknown}</span>
    <span class="init-hint">Install state is unavailable until this is resolved.</span>
    ${remedy}
  </div>
</div>`;
  }
  if (!state.scopes.projectOpen || state.scopes.projectConfigured) {
    return refreshing;
  }
  return html`${refreshing}
<div class="init-notification">
  <span class="codicon codicon-info init-icon"></span>
  <div class="init-body">
    <span>No grimoire.toml in this workspace — showing the global catalog instead.</span>
    <vscode-button class="sm" data-action="init-project">Initialize Project Config</vscode-button>
  </div>
</div>`;
}

/** One card, in the density and variant its tab calls for. `group` is the scope
 *  group it is being rendered under, when scope grouping is on — that is what
 *  decides which install the 'scope' variant reports; without it (kind/no
 *  grouping) the effective install picks. */
function tabRow(
  card: CardVM,
  state: SidebarState,
  view: ViewOptions,
  group?: CardGroup,
): TemplateResult {
  // A stale (storage-restored) round suppresses the same affordances an unknown
  // install state does: its `installs` are last session's, and an Install
  // button on an artifact that is in fact installed is the mis-click this
  // prevents. The Updates/Installed variants below keep theirs — Update and
  // Manage stay correct for an artifact that IS installed, and a stale round,
  // unlike an unknown one, still has real install data behind them.
  const installStateUnknown = state.installStateUnknown !== undefined || state.stale === true;
  if (view.density === 'compact') {
    return renderCompactRow(card, { installStateUnknown });
  }
  if (state.mode === 'updates') {
    return renderCard(card, { variant: 'updates' });
  }
  if (state.mode === 'installed') {
    const scope: Scope =
      group?.id === 'project' || group?.id === 'global'
        ? group.id
        : (effectiveInstall(card.installs)?.scope ?? 'project');
    return renderCard(card, { variant: 'scope', scope });
  }
  return renderCard(card, { installStateUnknown });
}

/** The results body for Browse and Installed: tree, grouped list, or flat list.
 *  Updates never gets here — it is a short single-purpose list (see below). */
function listBody(
  cards: CardVM[],
  state: SidebarState,
  view: ViewOptions,
  expanded: ExpandedNodes,
): TemplateResult {
  if (view.mode === 'tree') {
    const nodes = buildTree(cards, {
      registries: state.registries,
      projectName: state.scopes.projectName,
    });
    // Density applies to the tree too — as a scale on the whole tree, not a
    // card/row swap: a card indented under a namespace node is not a tree, and
    // "comfortable" here means the rows and their glyphs get bigger. One
    // container class does it, so nothing threads through the node renderer.
    const roomy = view.density === 'comfortable' ? ' roomy' : '';
    return html`<div class="tree${roomy}" role="tree">${treeNodes(nodes, state, view, expanded, 0)}</div>`;
  }
  const key = groupKeyFor(state.mode, view);
  if (key === 'none') {
    return html`${repeat(
      cards,
      (c) => c.repo,
      (c) => tabRow(c, state, view),
    )}`;
  }
  const groups = groupCards(cards, key, {
    registries: state.registries,
    projectName: state.scopes.projectName,
  });
  return html`${repeat(
    groups,
    (g) => g.id,
    (g) =>
      html`${groupHeader(g, expanded.has(g.id))}${
        expanded.has(g.id)
          ? html`${repeat(
              g.cards,
              // Keyed per group: an artifact installed in both scopes lands in
              // both, and lit requires the keys to be unique across the list.
              (c) => `${g.id}:${c.repo}`,
              (c) => tabRow(c, state, view, g),
            )}`
          : nothing
      }`,
  )}`;
}

function treeNodes(
  nodes: TreeNode[],
  state: SidebarState,
  view: ViewOptions,
  expanded: ExpandedNodes,
  depth: number,
): TemplateResult {
  return html`${repeat(
    nodes,
    (n) => n.id,
    (n) => {
      if (n.card) {
        return renderCompactRow(n.card, {
          depth,
          installStateUnknown: state.installStateUnknown !== undefined || state.stale === true,
        });
      }
      const open = expanded.has(n.id);
      return html`<button class="tree-node ${depthClass(depth)}" data-action="toggle-node" data-node="${n.id}" role="treeitem" aria-expanded="${open}">${twisty(open)}<span class="tree-label mono">${n.label}</span><span class="group-count">${n.count}</span>${registryMarks(n)}</button>${
        open ? treeNodes(n.children, state, view, expanded, depth + 1) : nothing
      }`;
    },
  )}`;
}

/** One installed view's card list (native-views split — the workbench owns
 *  the section chrome now). Host posts only this view's cards; here we apply the
 *  Kind filter and a client-side name filter for the search box. */
function renderInstalledResults(
  state: SidebarState,
  filter: CardFilter,
  view: ViewOptions,
  expanded: ExpandedNodes,
): TemplateResult {
  if (state.mode === 'updates') {
    // The WHOLE hasUpdate slice, deliberately unfiltered: this tab renders no
    // kind chips and no search box, while the count beside its label (and the
    // activity-bar badge, same derivation) is the unfiltered length. Running
    // the filter here made the two disagree — the `filter` that reaches this
    // branch is BROWSE's (main.ts activeFilter falls through to it for any tab
    // but Installed), so a kind chip set on Browse, which persists across
    // reloads, silently hid updates the badge was still counting: "3" over
    // "Everything is up to date." A `kind: null` card — installed, absent from
    // the catalog — dropped out of every chip-narrowed list the same way.
    return state.items.length
      ? html`${repeat(
          state.items,
          (c) => c.repo,
          (c) => tabRow(c, state, view),
        )}`
      : installedEmpty('Everything is up to date.');
  }
  // Installed view: BOTH scopes (the host posts both). Scope grouping replaced
  // the old Project/Global toggle, so nothing is sliced away here — an artifact
  // installed in both scopes appears under both headers, keyed per group.
  // The initialize-project notice lives in the top #sb-notice slot (above the
  // tabs, all modes) — no inline copy here.
  const cards = installedCards(state, filter);
  return cards.length
    ? listBody(cards, state, view, expanded)
    : installedEmpty('Nothing installed.');
}

function installedEmpty(text: string): TemplateResult {
  return html`<div class="installed-empty">${text}</div>`;
}

/** Item 3: the sidebar renders as six independently-updatable regions —
 *  notice, tabs, search row, filter row, results, footer — so a search-result
 *  state update rebuilds only the results (and, when its options change, the
 *  filters) and never the textfield the user is typing into. main.ts drives
 *  them separately; this composed form stays for the render tests and any
 *  full-render fallback. */
/** Sort fields, in the order the index site lists them. `relevance` leads on
 *  Browse because it is grim's own answer to a typed query; Installed drops it,
 *  since `grim status` ranks nothing for it to mean. */
const SORT_OPTIONS: ReadonlyArray<{ id: SortMode; label: string }> = [
  { id: 'relevance', label: 'relevance' },
  { id: 'name', label: 'name' },
  { id: 'updated', label: 'updated' },
  { id: 'rating', label: 'rating' },
];

/** Lucide's arrow-up-narrow-wide / arrow-down-wide-narrow, inlined: the index
 *  site's own glyphs, and the codicon set has no bars-and-arrow equivalent. The
 *  bars DRAW the order (short-to-tall under an up arrow) instead of labelling a
 *  flag, so the icon stays right whichever field is selected. */
const SORT_ASC_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/></svg>`;
const SORT_DESC_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/></svg>`;

/**
 * The index site's sort control, ported: a direction cap and the field sharing
 * one edge, sitting in the search row at the field's own height (the row
 * stretches, so neither half states a height).
 *
 * Selection is bound twice, and both are load-bearing. `?selected` carries the
 * FIRST paint: lit commits the select's `.value` before the child part that
 * renders the options, so at that moment there is nothing to select and only
 * the attribute on a freshly-created option decides. `.value` carries every
 * LATER one: an option's `selected` attribute stops steering the selection once
 * that option has been picked, and a tab switch (Browse and Installed keep
 * separate filters, and Installed drops the relevance entry) has to move it
 * programmatically.
 */
function sortControl(filter: CardFilter, mode: SidebarState['mode']): TemplateResult {
  const asc = filter.dir === 'asc';
  const label = asc ? 'Ascending — click for descending' : 'Descending — click for ascending';
  const options = SORT_OPTIONS.filter(
    (option) => option.id !== 'relevance' || mode === 'browse',
  );
  return html`<div class="sort-group" role="group" aria-label="Sort by">
    <button class="sort-dir" data-action="toggle-sort-dir" title="${label}" aria-label="${label}">${asc ? SORT_ASC_ICON : SORT_DESC_ICON}</button>
    <select class="sort-field" id="sort-field" aria-label="Sort by" title="Sort by" .value="${filter.sort}">${options.map(
      (option) =>
        html`<option value="${option.id}" ?selected="${option.id === filter.sort}">${option.label}</option>`,
    )}</select>
  </div>`;
}

export function renderSidebarSearch(
  state: SidebarState,
  filter: CardFilter = DEFAULT_FILTER,
): TemplateResult | typeof nothing {
  // The Updates view has no search box (short, single-purpose list). The view
  // controls are not in the webview at all: density, tree, grouping and
  // expand/collapse-all are the VIEW's chrome, so they live in its title bar
  // (package.json `view/title`), where the workbench already puts Explorer's
  // collapse-all and Search's view-mode toggle. That costs no row inside a
  // 300px sidebar, overflows into the `…` menu on its own, and makes every
  // control keyboard- and palette-reachable for free.
  if (state.phase === 'no-grim' || state.mode === 'updates') {
    return nothing;
  }
  // Clear "x" (item 4): slotted into the textfield's content-after; action-icon
  // renders it as a real, accessible button. Shown only when there's text —
  // toggled via the .hidden class so typing never rebuilds the textfield.
  const clearHidden = state.query ? '' : ' hidden';
  return html`<div class="search-row"><vscode-textfield id="search" placeholder="${
    state.mode === 'browse' ? 'Search artifacts…' : 'Search installed…'
  }" value="${state.query}"><vscode-icon slot="content-after" id="search-clear" class="clear-icon${clearHidden}" name="close" action-icon label="Clear search" title="Clear search" data-action="clear-search"></vscode-icon></vscode-textfield>${sortControl(filter, state.mode)}</div>`;
}

export function renderSidebarFilters(
  state: SidebarState,
  filter: CardFilter,
): TemplateResult | typeof nothing {
  if (state.phase !== 'ready') {
    return nothing;
  }
  // Updates: no chips (short, single-purpose list). Browse and Installed: the
  // Kind chips. Installed's SCOPE toggle is gone — scope grouping replaced it.
  // The view controls are NOT here: they belong immediately above the list they
  // reshape, so they render inside the results region (renderSidebarResults).
  return state.mode === 'updates' ? nothing : renderFilters(filter);
}

export function renderSidebarResults(
  state: SidebarState,
  filter: CardFilter,
  view: ViewOptions = DEFAULT_VIEW,
  expanded: ExpandedNodes = NONE_EXPANDED,
): TemplateResult {
  if (state.phase === 'no-grim') {
    return renderNoGrim();
  }
  if (state.phase === 'loading') {
    return renderLoading();
  }
  if (state.phase === 'error') {
    return html`<div class="error-state"><span class="codicon codicon-error"></span> ${state.error ?? 'Unknown error'}</div>`;
  }
  if (state.mode !== 'browse') {
    // Both installed-side tabs derive from status; with status unknown their
    // lists are empty for want of data, and "Nothing installed" would be a
    // claim we cannot make.
    if (state.installStateUnknown !== undefined) {
      return installedEmpty('Install state is unavailable.');
    }
    return renderInstalledResults(state, filter, view, expanded);
  }
  const filtered = filterCards(state.items, filter);
  const registries = registryCount(state);
  const summary =
    filtered.length > 0
      ? html`<div class="result-summary">${filtered.length} result${filtered.length === 1 ? '' : 's'} in ${registries} ${registries === 1 ? 'registry' : 'registries'}</div>`
      : nothing;
  const body = filtered.length === 0 ? renderEmpty(state) : listBody(filtered, state, view, expanded);
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
  const outdated = state.installedItems.filter(hasUpdate).length;
  // With status unavailable `installedItems` is empty for want of data, while
  // the native badge deliberately keeps its last known value — no pill would
  // read as zero and contradict it. Say "unknown" instead of a count.
  const updatesCount =
    state.installStateUnknown !== undefined
      ? html`<span class="tab-count" title="Update count unavailable — install state is unknown" aria-label="update count unavailable">?</span>`
      : outdated > 0
        ? html`<span class="tab-count">${outdated}</span>`
        : nothing;
  const tabs = SIDEBAR_TABS.map(({ id, label }) => {
    const count = id === 'updates' ? updatesCount : nothing;
    return html`<button class="tab${state.mode === id ? ' active' : ''}" data-action="set-tab" data-tab="${id}" aria-pressed="${state.mode === id}">${label}${count}</button>`;
  });
  return html`<div class="tabs sidebar-tabs">${tabs}</div>`;
}

/** The cached-catalog status line, rendered into its own bottom-pinned region
 *  (#sb-footer) so it never scrolls with results and is anchored at the
 *  bottom in every phase that has anything to show there (item 1) — loading
 *  included: it renders the SAME "Refreshing…" template main.ts swaps into
 *  this region for a background refresh over already-painted results, so the
 *  first-ever load (no painted state yet) pins it identically instead of
 *  leaving it stranded inside the scrollable skeleton. no-grim has nothing to
 *  sync or refresh, so it renders nothing. */
export function renderSidebarFooter(state: SidebarState): TemplateResult | typeof nothing {
  if (state.phase === 'ready' || state.phase === 'error') {
    return renderFooter(state);
  }
  if (state.phase === 'loading') {
    return renderRefreshingFooter(state.defaultRegistry ?? null);
  }
  return nothing;
}

export function renderSidebar(
  state: SidebarState,
  filter: CardFilter,
  view: ViewOptions = DEFAULT_VIEW,
  expanded: ExpandedNodes = NONE_EXPANDED,
): TemplateResult {
  return html`${renderSidebarNotice(state)}${renderSidebarTabs(state)}${renderSidebarSearch(
    state,
  )}${renderSidebarFilters(state, filter)}${renderSidebarResults(
    state,
    filter,
    view,
    expanded,
  )}${renderSidebarFooter(state)}`;
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
  ${
    vm.kind === 'bundle' && vm.members.length > 0
      ? railRow('Unit', `${vm.members.length} artifacts, installed together`)
      : nothing
  }
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
  ${
    // Skills-only annotation, null for every other kind by construction — so a
    // permanent "Not provided" row on an mcp or a bundle would be noise, not
    // information. The row appears only when grim reports a value.
    vm.compatibility ? railRow('Compatibility', html`<span class="mono">${vm.compatibility}</span>`) : nothing
  }
</div>`;
}

/** One RESOURCES/SUPPORT link row. Every URL leaves through the host's
 *  `open` action, which is the only sanctioned way out of the webview. */
function resourceLinkRow(icon: string, label: string, url: string): TemplateResult {
  return html`<div class="rail-link-row"><a href="#" class="resource-link" data-action="open" data-url="${url}"><span class="codicon codicon-${icon}"></span><span class="resource-label">${label}</span></a></div>`;
}

/** One RESOURCES static (non-link) row — the shape `License:` already uses. */
function resourceStaticRow(icon: string, label: string): TemplateResult {
  return html`<div class="rail-link-row"><span class="resource-link static"><span class="codicon codicon-${icon}"></span><span class="resource-label">${label}</span></span></div>`;
}

function renderResourcesPanel(vm: DetailsVM): TemplateResult | typeof nothing {
  // Widened with the curated annotations: an artifact carrying only
  // `documentation` (or only `authors`) must still get a panel.
  if (
    !vm.sourceRepository &&
    !vm.license &&
    !vm.homepage &&
    !vm.documentation &&
    !vm.authors &&
    !vm.vendor
  ) {
    return nothing;
  }
  const rows: TemplateResult[] = [];
  if (vm.sourceRepository) {
    rows.push(
      html`<div class="rail-link-row"><a href="#" class="resource-link" data-action="open" data-url="${vm.sourceRepository}"><span class="codicon codicon-github"></span><span class="resource-label">Source repository</span></a></div>`,
    );
  }
  if (vm.homepage) {
    rows.push(resourceLinkRow('globe', 'Homepage', vm.homepage));
  }
  if (vm.documentation) {
    rows.push(resourceLinkRow('book', 'Documentation', vm.documentation));
  }
  if (vm.authors) {
    rows.push(resourceStaticRow('organization', vm.authors));
  }
  if (vm.vendor) {
    rows.push(resourceStaticRow('briefcase', vm.vendor));
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

/** The SUPPORT rail panel: the maintainer's channels, up to four link rows.
 *  Omitted entirely when every channel is null, which is most packages today —
 *  same "empty panels are omitted" rule the RATING panel follows.
 *
 *  These ride the DESCRIPTION COMPANION, not the version manifest, so a moved
 *  link updates every published version with no digest change on any artifact.
 *  Nothing here needs cache work: the details cache's SWR short-circuit already
 *  compares the companion digest as well as the artifact digest, and a support
 *  edit re-points the companion tag. */
function renderSupportPanel(vm: DetailsVM): TemplateResult | typeof nothing {
  const { issues, chat, contact, security } = vm.support;
  if (!issues && !chat && !contact && !security) {
    return nothing;
  }
  const rows: TemplateResult[] = [];
  if (issues) {
    rows.push(resourceLinkRow('issues', 'Issue tracker', issues));
  }
  if (chat) {
    rows.push(resourceLinkRow('comment-discussion', 'Chat', chat));
  }
  if (contact) {
    const url = contactUrl(contact);
    // An address IS the useful label; a contact page URL is not, so that one
    // gets a name instead of a rail-wide link. A value that is neither renders
    // as inert text.
    const label = url === null || url.startsWith('mailto:') ? contact : 'Contact';
    rows.push(url ? resourceLinkRow('mail', label, url) : resourceStaticRow('mail', label));
  }
  if (security) {
    rows.push(resourceLinkRow('shield', 'Report a vulnerability', security));
  }
  return html`<div class="rail-panel"><div class="rail-title">SUPPORT</div>${rows}</div>`;
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
  // Installed + a named successor → a one-click switch (install the replacement
  // in every installed scope, then uninstall this one). The host derives the
  // scope set + identity; the read-only preview link above stays. Bundle-held
  // installs can't be torn down here, so they don't count as switchable.
  const switchable = vm.replacedBy !== null && vm.installs.some((i) => i.viaBundles.length === 0);
  const switchButton = switchable
    ? html`<button class="deprecation-switch" data-action="switch">Switch to replacement</button>`
    : nothing;
  return html`
<div class="deprecation-banner">
  <span class="codicon codicon-warning"></span>
  <span>This artifact is deprecated${replacement}. It can still be installed, but will not receive updates.${extra}</span>
  ${switchButton}
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

/** Per-scope Complete Install split button: shown when grim reports outputs an
 *  install would still write (`outputs_pending`). Same geometry as the Update
 *  split button, and it wins over Uninstall for the same reason Update does —
 *  it is the one thing worth doing on this row.
 *
 *  The label says Complete Install, not Repair, because `grim install` has no
 *  artifact positional: it re-materializes the whole scope's lock. Naming one
 *  artifact's button "Repair" would promise a narrower action than it performs. */
function scopeCompleteInstallButton(vm: DetailsVM, install: InstallVM): TemplateResult {
  return html`<div class="split-button sm"><button class="split-main" data-action="complete-install" data-scope="${install.scope}" title="${outputsPendingTooltip(install)}">Complete Install</button><button class="split-arrow" data-action="scope-menu" title="More options"><span class="codicon codicon-chevron-down"></span></button><div class="scope-menu hidden"><button class="menu-item" data-action="pick-version" data-repo="${vm.repo}" data-scope="${install.scope}"><span class="menu-label">Switch Version</span></button><button class="menu-item" data-action="uninstall" data-kind="${install.kind}" data-name="${install.name}" data-scope="${install.scope}"><span class="menu-label">Uninstall</span></button></div></div>`;
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

/** A scope whose install state could not be determined (`grim status` failed, or
 *  the binary is below the floor so it never ran): the same shell and column
 *  widths as every other row, a muted "unknown" cell, and NO action. An Install
 *  button here would be the positive "nothing is installed in this scope" claim
 *  we specifically cannot make — the artifact may well be installed. Per scope,
 *  unlike {@link pendingScopeRow}, which blanks the whole box. */
function unknownScopeRow(vm: DetailsVM, scope: Scope, divided: boolean): TemplateResult {
  const cells = html`<span class="scope-version scope-status-muted"><span class="mono scope-ver"></span><span class="scope-glyph"><span class="codicon codicon-question"></span></span><span>Install state unknown</span></span>
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
  const pending = hasOutputsPending(install);
  let versionInfo: TemplateResult;
  if (install.updateAvailable) {
    versionInfo = html`<span class="mono scope-ver">${install.version ?? ''}</span><span class="scope-glyph"><span class="status-dot"></span></span><span class="scope-update-hint">${vm.latestVersion ? `${vm.latestVersion} available` : 'update available'}</span>`;
  } else if (pending) {
    // Not "up to date" — it is at the right version, but an install would still
    // write. Info glyph, not a warning: nothing here is broken.
    versionInfo = html`<span class="mono scope-ver">${install.version ?? vm.latestVersion ?? ''}</span><span class="scope-glyph"><span class="codicon codicon-info"></span></span><span class="scope-pending-hint" title="${outputsPendingTooltip(install)}">install incomplete</span>`;
  } else {
    versionInfo = html`<span class="mono scope-ver">${install.version ?? vm.latestVersion ?? ''}</span><span class="scope-glyph"><span class="codicon codicon-check ok-check"></span></span><span class="scope-ok-hint">up to date</span>`;
  }
  // Update takes precedence on the one row button for a direct (non-bundle)
  // outdated install, then Complete Install; via-bundle rows always show the
  // Bundle nav button (its update path stays in the gear), and rows with nothing
  // outstanding show Uninstall.
  let button: TemplateResult;
  if (install.updateAvailable && install.viaBundles.length === 0) {
    button = scopeUpdateButton(vm, install);
  } else if (pending && install.viaBundles.length === 0) {
    button = scopeCompleteInstallButton(vm, install);
  } else {
    button = scopeUninstallButton(vm, install);
  }
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
    // Checked before `installs`: an unknown scope contributes no installs, so
    // the find below would fall through to the "Not installed" row.
    if (vm.unknownScopes?.includes(scope)) {
      return unknownScopeRow(vm, scope, index > 0);
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

/** The body of one markdown tab panel. Rendered HERE rather than left empty for
 *  main.ts to fill after boot: the host SSRs this same template into
 *  `webview.html`, so a cached README is in the FIRST HTML parse instead of
 *  waiting on the webview bundle to parse, register its elements and post
 *  `ready`. markdown-it runs with html:false, so its output is inert — the one
 *  sanctioned unsafeHTML source alongside highlightJson. */
function mdBody(markdown: string | null): unknown {
  return markdown ? unsafeHTML(md.render(markdown)) : nothing;
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
  return html`<div class="md-body" id="md-contents">${mdBody(vm.contentMarkdown)}</div>`;
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
  // No logo → the same monogram chip the sidebar rows show, tinted by the same
  // hash of the same repo, NOT the kind tile: one artifact must not have two
  // different faces depending on which surface you look at it from. The kind is
  // already stated by the badge beside the name.
  const icon = vm.logoUri
    ? html`<div class="header-icon"><img class="header-logo" src="${vm.logoUri}" alt=""/></div>`
    : html`<div class="header-icon monogram avatar-${avatarTint(vm.repo)}" aria-hidden="true">${monogram(vm.name)}</div>`;
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
      ${
        vm.isPreview
          ? html`<button class="header-share header-pin" data-action="promote" title="Keep open"><span class="codicon codicon-pin"></span></button>`
          : nothing
      }
    </div>
    <div class="header-desc">${headerDesc(vm.description)}</div>
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
  const panels = html`${hasDetails ? panel('details', first === 'details', html`<div class="md-body" id="md-details">${mdBody(vm.readmeMarkdown)}</div>`) : nothing}${panel('contents', first === 'contents', renderContentsBody(vm))}${hasChangelog ? panel('changelog', false, html`<div class="md-body" id="md-changelog">${mdBody(vm.changelogMarkdown)}</div>`) : nothing}`;
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
    ${renderRatingPanel(vm)}
    ${renderPackagePanel(vm)}
    ${renderResourcesPanel(vm)}
    ${renderSupportPanel(vm)}
    ${renderTagsPanel(vm)}
  </div>
</div>`;
}
