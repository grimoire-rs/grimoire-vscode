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

/** grim-polyfill<0.13.0: first grim accepting `config registry add
 *  --include/--exclude` and the `config registry set` verb. Copied from
 *  installer.ts's REGISTRY_EDIT_GRIM_VERSION, not imported — that module is
 *  host-only and this one is bundled into the webview. */
const REGISTRY_EDIT_GRIM_VERSION = '0.13.0';

/** The visible half of the version gate. A control that is merely absent reads
 *  as a feature this panel never had; naming the version it needs — and the one
 *  actually running, when that is known — is what turns it into something the
 *  user can act on. The running clause is omitted rather than guessed: a phase
 *  that never resolved a version would otherwise print "(running null)". */
const FILTER_GATE_LEAD = 'Browse filters need';
const EDIT_GATE_LEAD = 'Editing a registry needs';

function gateHint(lead: string, grimVersion: string | null): TemplateResult {
  const running = grimVersion === null ? '' : ` (running ${grimVersion})`;
  return html`<div class="row-hint">${lead} grim ${REGISTRY_EDIT_GRIM_VERSION} or newer${running}.</div>`;
}

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

function renderRegistryRow(r: SettingsRegistryVM, editSupported: boolean): TemplateResult {
  const aliasCell = r.legacy
    ? html`<span class="registry-alias legacy-alias">(no alias)${renderFilterMark(r)}</span>`
    : html`<span class="registry-alias">${r.alias}${renderFilterMark(r)}</span>`;
  // Default star: gold when set (design "#e2c08d" — mapped here to
  // --vscode-gitDecoration-modifiedResourceForeground, the closest existing
  // gold-ish token in the theme's default palette; no prior binding for this
  // hex exists elsewhere in the codebase, so this is the one place it's picked).
  // Both states are the same control. Promoting is `registry use`, which
  // clears the prior default in one atomic write; demoting has no verb of its
  // own — `--default` only ever sets — so it goes through the dotted key, the
  // same write the edit form's unchecked box makes.
  const defaultCell = r.default
    ? html`<button class="icon-button registry-star" data-action="unset-default-registry" data-alias="${r.alias ?? ''}" title="Clear default" ?disabled="${r.legacy}"><span class="codicon codicon-star-full"></span></button>`
    : html`<button class="icon-button registry-star-empty" data-action="use-registry" data-alias="${r.alias ?? ''}" title="Set default" ?disabled="${r.legacy}"><span class="codicon codicon-star-empty"></span></button>`;
  // grim-polyfill<0.13.0: an older grim rejects `config registry set` as an
  // unknown subcommand (clap, exit 64), so the button is hidden and
  // renderRegistries says why once, under the table. A legacy row stays
  // uneditable at every version — grim addresses entries by alias, and this one
  // has none. Delete the `editSupported` half of the condition with the gate.
  const editButton =
    r.legacy || !editSupported
      ? nothing
      : html`<button class="icon-button" data-action="edit-registry" data-alias="${r.alias ?? ''}" title="Edit"><span class="codicon codicon-edit"></span></button>`;
  // One grid child, whatever it holds: `.registry-row` is a five-column grid,
  // so an unwrapped pair of buttons would claim two columns and shift the row.
  const actionCell = r.legacy
    ? html`<span class="codicon codicon-lock registry-lock" title="Legacy entry — read-only"></span>`
    : html`<span class="registry-actions">${editButton}<button class="icon-button" data-action="remove-registry" data-alias="${r.alias ?? ''}" title="Remove"><span class="codicon codicon-trash"></span></button></span>`;
  const footnote = r.legacy
    ? html`<div class="registry-footnote">Legacy entry has no alias — add one by editing grimoire.toml directly.</div>`
    : nothing;
  // Filters are read-only in the table (renderFilterMark, in the alias cell).
  // Editing them happens in the form the pencil opens, never inline: `config
  // set` REPLACES the whole list and reports what it discarded to its log
  // rather than the JSON envelope, so a per-pattern control over that path
  // could save one and lose two undetectably. The form sends `registry set`
  // with one repeated flag per pattern, which writes the list whole.
  return html`
<div class="registry-entry${r.legacy ? ' legacy' : ''}">
  <div class="registry-row">
    ${defaultCell}
    ${aliasCell}
    <span class="registry-type mono">${r.type.toUpperCase()}</span>
    <span class="registry-locator mono">${r.locator}</span>
    ${actionCell}
  </div>
  ${footnote}
</div>`;
}

/** A marker beside the alias, only on an entry that actually carries filters —
 *  the unfiltered default needs no words. Counts and patterns live in its
 *  tooltip, listed per side, since which side a pattern is on IS its meaning. */
function renderFilterMark(r: SettingsRegistryVM): TemplateResult | typeof nothing {
  if (r.include.length === 0 && r.exclude.length === 0) {
    return nothing;
  }
  const tooltip = [
    r.include.length > 0 ? `Include (${r.include.length}):\n${r.include.join('\n')}` : '',
    r.exclude.length > 0 ? `Exclude (${r.exclude.length}):\n${r.exclude.join('\n')}` : '',
  ]
    .filter((s) => s !== '')
    .join('\n\n');
  return html`<span class="codicon codicon-filter registry-filter-mark" title="${tooltip}"></span>`;
}

function renderRegistryTable(
  registries: SettingsRegistryVM[],
  editSupported: boolean,
): TemplateResult {
  // The star column leads and carries no header: "DEFAULT" is four times wider
  // than the 20px track it would sit over, so restoring it means widening the
  // column at LOCATOR's expense. Each star states its own action in its
  // `title` ("Set default" / "Clear default") instead.
  return html`
<div class="registry-table">
  <div class="registry-row registry-header">
    <span></span><span>ALIAS</span><span>TYPE</span><span>LOCATOR</span><span></span>
  </div>
  ${repeat(
    registries,
    (r) => r.alias ?? r.locator,
    (r) => renderRegistryRow(r, editSupported),
  )}
</div>`;
}

function renderRegistries(
  state: SettingsState,
  addRegistry: AddRegistryUI,
  registryError: string | null,
): TemplateResult {
  const body =
    state.registries.length > 0
      ? renderRegistryTable(state.registries, state.registryEditSupported)
      : html`<div class="registries-empty">No registries configured</div>`;
  // grim-polyfill<0.13.0: said once under the table rather than per row, and
  // only where a row would otherwise have carried an edit button — a legacy
  // row has none at any version, so an all-legacy table is not gated at all.
  const editGate =
    !state.registryEditSupported && state.registries.some((r) => !r.legacy)
      ? gateHint(EDIT_GATE_LEAD, state.grimVersion)
      : nothing;
  const form = addRegistry.open
    ? renderAddRegistryForm(
        addRegistry,
        state.registryFields,
        state.registryEditSupported,
        state.grimVersion,
      )
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
  ${editGate}
  ${
    // The form REPLACES the button rather than stacking under it: they are two
    // states of one affordance, and an "Add Registry…" button live beneath an
    // open Edit form offers a second, conflicting entry point into the single
    // form slot the panel has. Cancelling or saving brings it back.
    addRegistry.open
      ? nothing
      : html`<button class="btn secondary" data-action="open-add-registry">Add Registry…</button>`
  }
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
function registryFieldLabel(
  fields: SettingsRegistryFieldVM[],
  key: string,
  fallback: string,
): string {
  return fields.find((f) => f.key === key)?.title ?? fallback;
}

/** The registry-kind radio's info tooltip: REGISTRY_HELP_COPY is always the
 *  preferred text (it reads better than grim's terser `description`); grim's
 *  description is only a fallback for a kind REGISTRY_HELP_COPY doesn't (yet)
 *  cover. */
function registryFieldTooltip(
  fields: SettingsRegistryFieldVM[],
  kind: AddRegistryDraft['kind'],
): string {
  return REGISTRY_HELP_COPY[kind] ?? fields.find((f) => f.key === kind)?.description ?? '';
}

function renderRegistryHelpTooltip(
  fields: SettingsRegistryFieldVM[],
  kind: AddRegistryDraft['kind'],
): TemplateResult {
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

/** The two glob lists' "what is this?". A native `<details>` rather than the
 *  radios' popover: `helpOpen` names a registry KIND, so a third topic cannot
 *  live in it, and a disclosure keeps its own state in the DOM. */
function renderFilterHelp(): TemplateResult {
  return html`
<details class="filter-help">
  <summary>How browse filters match</summary>
  <ul class="filter-help-list">
    <li>Patterns match the repository path with the registry host stripped — <code class="inline-code">acme/platform/**</code>, not <code class="inline-code">ghcr.io/acme/platform/**</code>.</li>
    <li>An empty include list shows everything; an empty exclude list hides nothing.</li>
    <li>Exclude wins — a path matched by both is hidden.</li>
    <li>A comma is glob alternation, so <code class="inline-code">acme/{a,b}/**</code> is ONE pattern, not two.</li>
  </ul>
</details>`;
}

/** One repeatable glob list in the add-registry form. The chip VISUALS are the
 *  settings-row chip editor's, but nothing else is: that editor commits a
 *  comma-JOINED string to a single config key, and a comma is glob alternation
 *  here. This one only edits the draft; the list ships as repeated
 *  `--include=`/`--exclude=` flags, the sole CLI path that writes more than one
 *  pattern.
 *
 *  The "enter to add" hint lives on the label row rather than the placeholder,
 *  which clears as soon as the list has an entry — an example the user has
 *  already followed is noise, but the key still needs naming. */
function renderPatternField(
  fields: SettingsRegistryFieldVM[],
  field: 'include' | 'exclude',
  patterns: string[],
  fallbackLabel: string,
  placeholder: string,
  editingIndex: number | null,
): TemplateResult {
  return html`
<div class="form-field">
  <span class="form-label pattern-label">${registryFieldLabel(fields, field, fallbackLabel)}<span class="pattern-hint">enter to add</span></span>
  <div class="chip-editor pattern-editor">
    ${repeat(
      patterns,
      // Keyed by position, not by value: the editing chip's value changes as
      // it is typed into, and a value key would tear the input down and lose
      // focus on every keystroke.
      (_p, i) => `${field}:${i}`,
      (p, i) =>
        i === editingIndex
          ? // Width is deliberately NOT set here. main.ts measures the element
            // after every render and on every keystroke (sizePatternEdit), and
            // one sizing path is the point: when the template also guessed a
            // width, the two disagreed and the editor opened far wider than
            // the text it held, snapping right only once the first keystroke
            // handed it to the path that measures.
            html`<input type="text" class="pattern-input pattern-edit mono" data-pattern-field="${field}" data-index="${i}" .value="${p}" />`
          : // Both buttons name their pattern — unlabelled, the pair announced
            // as "acme/** button, button" — and address it by INDEX, the way
            // model.ts's removePattern does: by value, a repeated glob loses
            // every twin instead of the one that was clicked.
            html`<span class="chip chip-free mono"><button class="chip-label" data-action="edit-pattern" data-pattern-field="${field}" data-index="${i}" title="Edit" aria-label="Edit ${p}">${p}</button><button class="chip-remove" data-action="remove-pattern" data-pattern-field="${field}" data-index="${i}" data-value="${p}" aria-label="Remove ${p}"><span class="codicon codicon-close"></span></button></span>`,
    )}
    <input type="text" class="pattern-input mono" data-pattern-field="${field}" placeholder="${patterns.length === 0 ? placeholder : ''}" aria-label="Add ${field} pattern" />
  </div>
</div>`;
}

/** The one registry form, in both its modes (`addRegistry.mode`). Editing
 *  reuses it wholesale rather than growing a second form: the fields are the
 *  same five, the validation is the same, and grim's `registry set` mirrors
 *  `registry add` flag for flag — a separate editor would be the same markup
 *  with a different submit action, and would drift.
 *
 *  Takes the whole `AddRegistryUI` rather than six splatted members: they all
 *  arrive from one object at the call site, and two of them were adjacent
 *  booleans no reader could tell apart at the call. */
function renderAddRegistryForm(
  addRegistry: AddRegistryUI,
  fields: SettingsRegistryFieldVM[],
  registryEditSupported: boolean,
  grimVersion: string | null,
): TemplateResult {
  const { draft, helpOpen, mode, saving, editingPattern, error } = addRegistry;
  const editing = mode.kind === 'edit';
  const editingIndex = (field: 'include' | 'exclude'): number | null =>
    editingPattern?.field === field ? editingPattern.index : null;
  // role="alert": the failure arrives while focus is wherever the save left it
  // (`inert` moved it to document.body), so the message has to announce itself
  // rather than wait to be found.
  const errorLine = error
    ? html`<div class="row-error" role="alert"><span class="codicon codicon-error"></span>${error}</div>`
    : nothing;
  // grim-polyfill<0.13.0: an older grim rejects the two flags as unknown (clap,
  // exit 64), so the repeaters are replaced by the line that says which grim
  // grows them back. Filters are optional, so the rest of the form is
  // unaffected. Delete the gate (keep the fields) with the version constant.
  const filterFields = registryEditSupported
    ? html`
  ${renderFilterHelp()}
  ${renderPatternField(fields, 'include', draft.include, 'Include patterns', 'acme/platform/**', editingIndex('include'))}
  ${renderPatternField(fields, 'exclude', draft.exclude, 'Exclude patterns', 'acme/platform/legacy/**', editingIndex('exclude'))}`
    : gateHint(FILTER_GATE_LEAD, grimVersion);
  // A registry write is several grim invocations behind a per-scope queue and a
  // lock retry, so it is visibly slow. `inert` takes the whole subtree out of
  // interaction in one attribute — including the repeaters' delegated handlers
  // — and the spinner says which of "slow" and "stuck" this is.
  const submitLabel = editing ? 'Save' : 'Add Registry';
  // The alias is readonly while editing because grim has no rename: changing
  // one is `rm` + `add`, a destructive round trip this form will not perform.
  // Visible text, not the `title` it used to be — the field otherwise looks
  // editable and swallows every keystroke. INSIDE the label, so it is part of
  // the field's accessible name too rather than a floating sentence.
  const aliasHint = editing
    ? html`<div class="row-hint">grim has no rename — remove and re-add to change an alias.</div>`
    : nothing;
  return html`
<div class="add-registry-form${saving ? ' saving' : ''}" ?inert="${saving}">
  <div class="form-title" tabindex="-1">${editing ? 'Edit registry' : 'Add registry'}</div>
  <label class="form-field">
    <span class="form-label">Alias</span>
    <input type="text" class="settings-input form-alias${error ? ' error' : ''}" data-field="alias" value="${draft.alias}" ?readonly="${editing}" />
    ${aliasHint}
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
  ${filterFields}
  <label class="checkbox-label"><input type="checkbox" data-field="default" ?checked="${draft.default}" />${registryFieldLabel(fields, 'default', 'Set as default registry')}</label>
  ${errorLine}
  <div class="form-actions">
    <button class="btn primary" data-action="submit-add-registry" ?disabled="${saving || !addRegistryDraftValid(draft)}">${saving ? html`<span class="codicon codicon-loading codicon-modifier-spin"></span>Saving…` : submitLabel}</button>
    <button class="btn secondary" data-action="cancel-add-registry" ?disabled="${saving}">Cancel</button>
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
