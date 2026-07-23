// lit-html renderers for the Settings panel. Colors are `--vscode-*` tokens
// only, reusing the exact bindings already established in sidebar.css/details.css for
// shared hexes. New mappings this view introduces (documented at each use
// site below): error-red -> --vscode-inputValidation-errorBorder /
// --vscode-errorForeground, default-star gold -> the same
// --vscode-gitDecoration-modifiedResourceForeground the codebase has no prior
// binding for (picked here, once), chip-selected accent -> --vscode-focusBorder.
import { html, nothing, type TemplateResult } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { createMarkdown } from '../markdown';
import type {
  SettingsGroupVM,
  SettingsRegistryFieldVM,
  SettingsRegistryVM,
  SettingsRowVM,
  SettingsState,
} from '../protocol';
import {
  addRegistryDraftValid,
  CLOSED_ADD_REGISTRY,
  enumSelectedValue,
  LOCATOR_PLACEHOLDER,
  splitList,
  type AddRegistryDraft,
  type AddRegistryUI,
} from './model';

// Full documentation site (../grimoire/README.md's `[docs]: https://grimoire.rs/`).
const DOCS_URL = 'https://grimoire.rs/';

const md = createMarkdown();

/** Row description rendered as inline markdown, same html:false + unsafeHTML
 *  path as the details/sidebar header description (render.ts's headerDesc). */
function rowDescription(description: string): TemplateResult | string {
  return description ? html`${unsafeHTML(md.renderInline(description))}` : '';
}

function rowTrailing(row: SettingsRowVM): TemplateResult | typeof nothing {
  // Mutually exclusive per design item 3: saving/reloaded badges take priority
  // over the discard icon, which itself only shows when the key is set.
  if (row.status === 'saving') {
    return html`<span class="row-badge"><span class="codicon codicon-loading codicon-modifier-spin"></span>Saving…</span>`;
  }
  if (row.status === 'reloaded') {
    return html`<span class="row-badge"><span class="codicon codicon-sync"></span>Reloaded from disk</span>`;
  }
  if (row.set) {
    return html`<button class="row-discard" data-action="discard" data-key="${row.key}" title="Reset to default"><span class="codicon codicon-discard"></span></button>`;
  }
  return nothing;
}

function toggleControl(row: SettingsRowVM): TemplateResult {
  const on = row.value === 'true';
  return html`<button class="toggle${on ? ' on' : ''}" role="switch" aria-checked="${on}" data-action="toggle-bool" data-key="${row.key}"><span class="toggle-knob"></span></button>`;
}

function dropdownControl(row: SettingsRowVM): TemplateResult {
  const options = row.values ?? [];
  const selected = enumSelectedValue(row);
  return html`<select class="settings-select" data-key="${row.key}">
    ${options.map((v) => html`<option value="${v}" ?selected="${v === selected}">${v}</option>`)}
  </select>`;
}

function textControl(row: SettingsRowVM): TemplateResult {
  const errorClass = row.status === 'error' ? ' error' : '';
  // `.value` is a PROPERTY binding (leading dot), not an attribute binding.
  // Once a user types into an <input>, the HTML "dirty value flag" makes the
  // browser ignore further `setAttribute('value', …)` calls for display
  // purposes — a plain `value="${…}"` binding would silently stop updating
  // the visible text on a programmatic revert (discard, a rejected write's
  // rollback, an external-reload repost) even though the row's own state
  // (badge, left border, hint) moves on. Setting the `.value` IDL property
  // instead always drives what's shown, dirty or not.
  return html`<input type="text" class="settings-input${errorClass}" data-key="${row.key}" .value="${row.value ?? ''}" />`;
}

function numberControl(row: SettingsRowVM): TemplateResult {
  const errorClass = row.status === 'error' ? ' error' : '';
  // Same dirty-value-flag reasoning as textControl's `.value` binding.
  return html`<input type="number" min="0" class="settings-input settings-input-number mono${errorClass}" data-key="${row.key}" .value="${row.value ?? ''}" />`;
}

/** Closed-set chips (Clients): every known value renders as a chip; membership
 *  in the comma-joined value toggles it. Immediate commit (main.ts), no
 *  add/remove chip editor. */
function closedChips(row: SettingsRowVM): TemplateResult {
  const selected = new Set(splitList(row.value));
  const options = row.values ?? [];
  return html`<div class="chips chips-closed" data-key="${row.key}">
    ${options.map((v) => {
      const isSelected = selected.has(v);
      return html`<button class="chip chip-closed${isSelected ? ' selected' : ''}" data-action="toggle-chip" data-key="${row.key}" data-value="${v}" aria-pressed="${isSelected}">${isSelected ? html`<span class="codicon codicon-check"></span>` : nothing}${v}</button>`;
    })}
  </div>`;
}

/** Free chip editor (Tree separators): existing chips + a ghost-placeholder
 *  add-input. The item-shape rule (row.constraints, or the single-char
 *  fallback) is a client-side guard (model.ts isValidChip); main.ts sets
 *  row.status='error' locally on violation without a round trip, so this
 *  renders the SAME error line a server rejection would. */
function freeChips(row: SettingsRowVM): TemplateResult {
  const chips = splitList(row.value);
  return html`<div class="chip-editor${row.status === 'error' ? ' error' : ''}" data-key="${row.key}">
    ${repeat(
      chips,
      (c) => c,
      (c) =>
        html`<span class="chip chip-free mono">${c}<button class="chip-remove" data-action="remove-chip" data-key="${row.key}" data-value="${c}"><span class="codicon codicon-close"></span></button></span>`,
    )}
    <input type="text" class="chip-input" data-key="${row.key}" placeholder="Add separator…" />
  </div>`;
}

function readonlyControl(row: SettingsRowVM): TemplateResult {
  return html`<div class="settings-readonly mono">${row.value ?? '—'}</div>`;
}

/** Exported for a focused regression test (settingsRender.test.ts): text/
 *  number controls must keep binding `.value` as a property, not an
 *  attribute — see textControl/numberControl's dirty-value-flag comment. */
export function renderControl(row: SettingsRowVM): TemplateResult {
  switch (row.type) {
    case 'boolean':
      return toggleControl(row);
    case 'enum':
      return dropdownControl(row);
    case 'string':
      return textControl(row);
    case 'integer':
      return numberControl(row);
    case 'string-set':
      return closedChips(row);
    case 'string-list':
      return freeChips(row);
    case 'unknown':
      return readonlyControl(row);
    default: {
      // Exhaustiveness guard (quality-typescript.md): a new SettingsControlType
      // added to the protocol without a case here fails the build, not silently
      // renders nothing.
      const exhaustive: never = row.type;
      throw new Error(`Unhandled settings control type: ${String(exhaustive)}`);
    }
  }
}

function renderRow(row: SettingsRowVM): TemplateResult {
  const stateClass = row.modified ? ' modified' : '';
  const savingClass = row.status === 'saving' ? ' saving' : '';
  const errorLine =
    row.status === 'error' && row.errorMessage
      ? html`<div class="row-error"><span class="codicon codicon-error"></span>${row.errorMessage}</div>`
      : nothing;
  return html`
<div class="settings-row${stateClass}${savingClass}" data-key="${row.key}">
  <div class="row-title-line">
    <span class="row-title">${row.title}</span>
    ${rowTrailing(row)}
  </div>
  <div class="row-desc">${rowDescription(row.description)}</div>
  <div class="row-control">${renderControl(row)}</div>
  ${errorLine}
  <div class="row-hint">${row.hint}</div>
</div>`;
}

function renderGroup(group: SettingsGroupVM): TemplateResult {
  return html`
<div class="settings-group">
  <h2 class="group-header">${group.title}</h2>
  ${repeat(group.rows, (r) => r.key, renderRow)}
</div>`;
}

// --- Registries ---

function renderRegistryRow(r: SettingsRegistryVM): TemplateResult {
  const aliasCell = r.legacy
    ? html`<span class="registry-alias legacy-alias">(no alias)</span>`
    : html`<span class="registry-alias">${r.alias}</span>`;
  // Default star: gold when set (design "#e2c08d" — mapped here to
  // --vscode-gitDecoration-modifiedResourceForeground, the closest existing
  // gold-ish token in the theme's default palette; no prior binding for this
  // hex exists elsewhere in the codebase, so this is the one place it's picked).
  const defaultCell = r.default
    ? html`<span class="codicon codicon-star-full registry-star" title="Default registry"></span>`
    : html`<button class="icon-button registry-star-empty" data-action="use-registry" data-alias="${r.alias ?? ''}" title="Set default" ?disabled="${r.legacy}"><span class="codicon codicon-star-empty"></span></button>`;
  const actionCell = r.legacy
    ? html`<span class="codicon codicon-lock registry-lock" title="Legacy entry — read-only"></span>`
    : html`<button class="icon-button" data-action="remove-registry" data-alias="${r.alias ?? ''}" title="Remove"><span class="codicon codicon-trash"></span></button>`;
  const footnote = r.legacy
    ? html`<div class="registry-footnote">Legacy entry has no alias — add one by editing grimoire.toml directly.</div>`
    : nothing;
  return html`
<div class="registry-row${r.legacy ? ' legacy' : ''}">
  ${aliasCell}
  <span class="registry-type mono">${r.type.toUpperCase()}</span>
  <span class="registry-locator mono">${r.locator}</span>
  ${defaultCell}
  ${actionCell}
</div>
${footnote}`;
}

function renderRegistryTable(registries: SettingsRegistryVM[]): TemplateResult {
  return html`
<div class="registry-table">
  <div class="registry-row registry-header">
    <span>ALIAS</span><span>TYPE</span><span>LOCATOR</span><span>DEFAULT</span><span></span>
  </div>
  ${repeat(registries, (r) => r.alias ?? r.locator, renderRegistryRow)}
</div>`;
}

function renderRegistries(
  state: SettingsState,
  addRegistry: AddRegistryUI,
  registryError: string | null,
): TemplateResult {
  const body =
    state.registries.length > 0
      ? renderRegistryTable(state.registries)
      : html`<div class="registries-empty">No registries configured</div>`;
  const form = addRegistry.open
    ? renderAddRegistryForm(state.registryFields, addRegistry.draft, addRegistry.helpOpen, addRegistry.error)
    : nothing;
  // A rejected remove/set-default click is keyed by alias (neither a config
  // row nor the add-registry form), so it surfaces here — the table-level
  // scope this action operates in — rather than being silently swallowed.
  const errorLine = registryError
    ? html`<div class="row-error"><span class="codicon codicon-error"></span>${registryError}</div>`
    : nothing;
  return html`
<div class="settings-group registries-group">
  <h2 class="group-header">Registries</h2>
  <p class="registries-blurb">Registries configured in this scope. Aliases can be used in place of full references.</p>
  ${errorLine}
  ${body}
  <button class="btn secondary" data-action="open-add-registry">Add Registry…</button>
  ${form}
</div>`;
}

/** Per-radio info tooltip copy — verified against
 *  ../grimoire/docs/src/{configuration,concepts,package-index}.md's registries
 *  sections. No dynamic bindings (no new escaping surface). STAYS the
 *  preferred tooltip text over grim's fetched `description` (registryFieldsArgs)
 *  — grim's copy is terser and would regress this UX; see registryFieldTooltip,
 *  whose fallback to grim's description only fires for a kind this map doesn't
 *  (yet) cover. */
const REGISTRY_HELP_COPY: Record<AddRegistryDraft['kind'], string> = {
  index:
    'Points at a package index — an https:// base or git repository URL — that curates the packages grim can discover. Choose this for curated catalogs like the hosted Grimoire index (the common case).',
  oci: 'Points directly at an OCI registry host or namespace, for example ghcr.io/acme. grim lists and pulls artifacts straight from the registry — choose this for private registries or when you publish artifacts yourself.',
};

/** grim's `title` for a registry-form field (`key` is "oci"/"index"/
 *  "default"), preferring the fetched metadata over the hardcoded
 *  `fallback` label — see registryFieldsArgs (grim.ts) and
 *  SettingsManager.ensureRegistryFields. Falls back when the fetch failed
 *  (state.registryFields is `[]`) or grim's fields list doesn't (yet)
 *  include this key (forward-compat with an older grim). */
function registryFieldLabel(fields: SettingsRegistryFieldVM[], key: string, fallback: string): string {
  return fields.find((f) => f.key === key)?.title ?? fallback;
}

/** The registry-kind radio's info tooltip: REGISTRY_HELP_COPY is always the
 *  preferred text (it reads better than grim's terser `description`); grim's
 *  description is only a fallback for a kind REGISTRY_HELP_COPY doesn't (yet)
 *  cover. */
function registryFieldTooltip(fields: SettingsRegistryFieldVM[], kind: AddRegistryDraft['kind']): string {
  return REGISTRY_HELP_COPY[kind] ?? fields.find((f) => f.key === kind)?.description ?? '';
}

function renderRegistryHelpTooltip(fields: SettingsRegistryFieldVM[], kind: AddRegistryDraft['kind']): TemplateResult {
  return html`<div class="registry-help-tooltip">${registryFieldTooltip(fields, kind)}</div>`;
}

function renderRegistryKindOption(
  fields: SettingsRegistryFieldVM[],
  draft: AddRegistryDraft,
  helpOpen: AddRegistryDraft['kind'] | null,
  kind: AddRegistryDraft['kind'],
  fallbackLabel: string,
): TemplateResult {
  const label = registryFieldLabel(fields, kind, fallbackLabel);
  return html`
<span class="radio-kind-wrap">
  <label class="radio-label"><input type="radio" name="registry-kind" data-field="kind" value="${kind}" ?checked="${draft.kind === kind}" />${label}</label>
  <button class="icon-button form-info-button" data-action="toggle-registry-help" data-kind="${kind}" title="What is this?"><span class="codicon codicon-info"></span></button>
  ${helpOpen === kind ? renderRegistryHelpTooltip(fields, kind) : nothing}
</span>`;
}

function renderAddRegistryForm(
  fields: SettingsRegistryFieldVM[],
  draft: AddRegistryDraft,
  helpOpen: AddRegistryDraft['kind'] | null,
  error?: string,
): TemplateResult {
  const errorLine = error
    ? html`<div class="row-error"><span class="codicon codicon-error"></span>${error}</div>`
    : nothing;
  return html`
<div class="add-registry-form">
  <div class="form-title">Add registry</div>
  <label class="form-field">
    <span class="form-label">Alias</span>
    <input type="text" class="settings-input form-alias${error ? ' error' : ''}" data-field="alias" value="${draft.alias}" />
  </label>
  <div class="form-field">
    <span class="form-label">Type</span>
    <div class="radio-row">
      ${renderRegistryKindOption(fields, draft, helpOpen, 'index', 'Index')}
      ${renderRegistryKindOption(fields, draft, helpOpen, 'oci', 'OCI')}
    </div>
  </div>
  <label class="form-field">
    <span class="form-label">Locator</span>
    <input type="text" class="settings-input form-locator" data-field="locator" placeholder="${LOCATOR_PLACEHOLDER[draft.kind]}" value="${draft.locator}" />
  </label>
  <label class="checkbox-label"><input type="checkbox" data-field="default" ?checked="${draft.default}" />${registryFieldLabel(fields, 'default', 'Set as default registry')}</label>
  ${errorLine}
  <div class="form-actions">
    <button class="btn primary" data-action="submit-add-registry" ?disabled="${!addRegistryDraftValid(draft)}">Add Registry</button>
    <button class="btn secondary" data-action="cancel-add-registry">Cancel</button>
  </div>
</div>`;
}

// --- Empty / init states ---

function renderEmptyPanel(
  icon: string,
  title: string,
  body: unknown = nothing,
  action: unknown = nothing,
): TemplateResult {
  return html`
<div class="settings-empty">
  <span class="codicon codicon-${icon} settings-empty-icon"></span>
  <p class="settings-empty-title">${title}</p>
  <p class="settings-empty-body">${body}</p>
  ${action}
</div>`;
}

function renderProjectNoToml(): TemplateResult {
  const body = html`Project-scope settings live in <code class="inline-code">grimoire.toml</code>. Initialize it to configure grim for this workspace.`;
  const action = html`<button class="btn primary settings-empty-action" data-action="init-project">Initialize Project Config</button>`;
  return renderEmptyPanel('file-code', 'No grimoire.toml in this workspace', body, action);
}

function renderNoFolder(): TemplateResult {
  return renderEmptyPanel('file-code', 'Open a folder to configure project scope');
}

/** Mirrors renderProjectNoToml (3c pattern) — the one difference is the path
 *  chip: Global's config_path isn't a fixed repo-relative string like
 *  project's `grimoire.toml`, since $GRIM_HOME is overridable, so
 *  the copy renders the REAL path grim reported (state.rawConfigPath) rather
 *  than a hardcoded string. */
function renderGlobalNoToml(state: SettingsState): TemplateResult {
  const body = html`Global-scope settings live in <code class="inline-code">${state.rawConfigPath ?? 'the global config'}</code>. Initialize it to configure grim across every project on this machine.`;
  const action = html`<button class="btn primary settings-empty-action" data-action="init-global">Initialize Global Config</button>`;
  return renderEmptyPanel('file-code', 'No global grimoire.toml yet', body, action);
}

function renderNoGrim(): TemplateResult {
  const body = html`The <code class="inline-code">grim</code> CLI is not on your PATH.`;
  const action = html`<button class="btn primary settings-empty-action" data-action="install-grim">Install grim</button>`;
  return renderEmptyPanel('warning', 'grim was not found', body, action);
}

function renderLoading(): TemplateResult {
  return html`<div class="settings-loading"><vscode-progress-ring></vscode-progress-ring></div>`;
}

function renderSettingsBody(
  state: SettingsState,
  addRegistry: AddRegistryUI,
  registryError: string | null,
): TemplateResult {
  switch (state.phase) {
    case 'no-grim':
      return renderNoGrim();
    case 'no-folder':
      return renderNoFolder();
    case 'project-no-toml':
      return renderProjectNoToml();
    case 'global-no-toml':
      return renderGlobalNoToml(state);
    case 'loading':
      return renderLoading();
    case 'error':
      return html`<div class="error-state"><span class="codicon codicon-error"></span>${state.error ?? 'Unknown error'}</div>`;
    case 'ready':
      return html`${state.groups.map(renderGroup)}${renderRegistries(state, addRegistry, registryError)}`;
    default: {
      const exhaustive: never = state.phase;
      throw new Error(`Unhandled settings phase: ${String(exhaustive)}`);
    }
  }
}

export function renderSettingsTabs(state: SettingsState): TemplateResult {
  const tabs: { id: 'project' | 'global'; label: string }[] = [
    { id: 'project', label: 'Project' },
    { id: 'global', label: 'Global' },
  ];
  const pathLabel = state.configPath
    ? html`<span class="settings-path mono">${state.configPath}</span>`
    : nothing;
  // Inner wrapper shares .settings-content's max-width/horizontal-padding
  // metrics (item 2 design fix) so the tabs' left edge and the path label's
  // right edge line up with the body content instead of the full-bleed
  // panel width; the border-bottom stays on the outer, full-bleed bar
  // (native VS Code Settings does the same split).
  return html`
<div class="settings-tabs">
  <div class="settings-tabs-inner">
    ${tabs.map(
      (t) =>
        html`<button class="settings-tab${state.scope === t.id ? ' active' : ''}" data-action="set-scope" data-scope="${t.id}" aria-pressed="${state.scope === t.id}">${t.label}</button>`,
    )}
    ${pathLabel}
  </div>
</div>`;
}

/** Flags an edit that lands in a scope Browse is not reading. The two scope
 *  choices are independent (this panel edits its open tab; Browse derives its
 *  own from live project state) and grim never merges scope config, so the
 *  write silently has no effect on what Browse shows. Editing the other scope
 *  deliberately is legitimate — this states the fact, it does not override the
 *  tab. */
export function renderScopeMismatch(state: SettingsState): TemplateResult | typeof nothing {
  if (state.searchScope === undefined || state.searchScope === state.scope) {
    return nothing;
  }
  const label = (scope: SettingsState['scope']): string =>
    scope === 'project' ? 'Project' : 'Global';
  // Split the fact from the remedy into separate lines, mirroring the sidebar's
  // `.init-hint` two-line notice: the second line names the action (switch this
  // panel to the tab Browse reads, so an edit here affects what Browse shows)
  // rather than leaving the mismatch stated with no way out. Wrapped in a block
  // text column so the two lines stack beside the icon — `.scope-mismatch` is a
  // flex row, so bare sibling spans would sit side by side instead.
  return html`
<div class="scope-mismatch">
  <span class="codicon codicon-info"></span>
  <div class="scope-mismatch-text">
    <div class="scope-mismatch-fact">Browse is searching ${label(state.searchScope)} scope — these settings apply to ${label(state.scope)}.</div>
    <div class="scope-mismatch-remedy">Switch to the ${label(state.searchScope)} tab to change what Browse sees.</div>
  </div>
</div>`;
}

export function renderSettingsFooter(): TemplateResult {
  return html`
<div class="settings-footer">
  <div class="settings-footer-inner">
    <button class="link-button" data-action="open-vscode-settings">VS Code settings</button>
    <button class="link-button" data-action="open-config-file">Open grimoire.toml</button>
    <button class="link-button" data-action="open-docs" data-url="${DOCS_URL}">Documentation</button>
  </div>
</div>`;
}

export function renderSettingsContent(
  state: SettingsState,
  addRegistry: AddRegistryUI = CLOSED_ADD_REGISTRY,
  registryError: string | null = null,
  /** True while a scope switch's cached VM is showing and the host's fresh
   *  confirmation for it hasn't landed yet (item 3) — a plain class toggle
   *  on the SAME wrapper, never a different template shape, so it dims the
   *  form in place instead of swapping it out. */
  refreshing = false,
): TemplateResult {
  return html`<div class="settings-content${refreshing ? ' refreshing' : ''}">${renderScopeMismatch(state)}${renderSettingsBody(state, addRegistry, registryError)}</div>`;
}

export function renderSettings(
  state: SettingsState,
  addRegistry: AddRegistryUI = CLOSED_ADD_REGISTRY,
  registryError: string | null = null,
  refreshing = false,
): TemplateResult {
  return html`${renderSettingsTabs(state)}${renderSettingsContent(state, addRegistry, registryError, refreshing)}${renderSettingsFooter()}`;
}
