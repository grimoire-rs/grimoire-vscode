// Settings webview entry: dumb event wiring over the pure lit renderers, same
// shape as sidebar/main.ts and details/main.ts. Per-row transient status
// (saving/error/reloaded) is mutated directly onto the held `vm` object —
// the same pattern details/main.ts uses for `vm.busy`.
import './settings.css';
import '@vscode-elements/elements/dist/vscode-progress-ring/index.js';
import { render as litRender } from 'lit-html';
import {
  registryFieldKey,
  type Scope,
  type SettingsRowVM,
  type SettingsState,
  type SettingsToHost,
  type HostToSettings,
} from '../protocol';
import {
  addRegistryDraftValid,
  allRows,
  appendPattern,
  chipHasComma,
  CLOSED_ADD_REGISTRY,
  consumeAwaitingConfirm,
  DUPLICATE_PATTERN_ERROR,
  editRegistryUI,
  isModified,
  isPatternField,
  isValidChip,
  isValidInteger,
  joinList,
  registrySubmitMessage,
  reloadedKeys,
  removePattern,
  replacePattern,
  resolveScopeSwitch,
  revealScrollDelta,
  shouldBlockNumberWheel,
  splitList,
  toggleRegistryHelp,
  type AddRegistryDraft,
  type AddRegistryUI,
} from './model';
import { renderSettings } from './render';

declare function acquireVsCodeApi(): {
  postMessage(message: SettingsToHost): void;
  getState(): { scope?: Scope } | undefined;
  setState(state: { scope?: Scope }): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;

// The host stamps this before the webview boots (spec: default tab is Project
// when a workspace folder is open, else Global) — read once, then vscode.setState
// remembers the user's own choice across reopens like the sidebar's activeTab.
const projectOpen = root.dataset['projectOpen'] === 'true';
const saved = vscode.getState();
let currentScope: Scope = saved?.scope ?? (projectOpen ? 'project' : 'global');

let vm: SettingsState | null = null;
// Last state seen per scope — lets a switch back to an already-visited scope
// show its form immediately (model.ts's resolveScopeSwitch) instead of the
// structurally different 'loading' placeholder, so lit-html patches rows in
// place rather than tearing the whole form down and rebuilding it (item 3).
const scopeCache = new Map<Scope, SettingsState>();
// True while a cached scope's VM is showing and the host's fresh fetch for it
// hasn't confirmed yet — render.ts turns this into a non-structural dim,
// never a template swap.
let refreshing = false;
// Snapshot of every row's last-confirmed value + set-ness (the scope currently
// in `vm`) — used to revert a rejected write (exit 65, or a rejected discard)
// to the pre-edit state. `set` is snapshotted alongside `value` (not derived
// from it) because a key can be explicitly set to a value equal to its
// default — `modified` alone can't tell the two apart.
let lastGoodValues = new Map<string, { value: string | null; set: boolean }>();
// Debounced text/number/chip-add commits, keyed by config key.
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Non-zero while at least one write this webview issued hasn't been confirmed
// by a 'state' repost yet — gates the reload-diff badge so the confirmation of
// our OWN write never gets mistaken for an external file change. See
// model.ts's consumeAwaitingConfirm for the credit-counting contract.
let awaitingConfirm = 0;
let reloadedFadeTimer: ReturnType<typeof setTimeout> | undefined;

let addRegistry: AddRegistryUI = CLOSED_ADD_REGISTRY;
let pendingRegistryAlias: string | null = null;
// Transient banner for a rejected registry rm/use (there is no row or form to
// attach it to the way a config-key write or an add-registry submission has —
// see handleWriteError's fallback branch).
let registryError: string | null = null;

function persist(): void {
  vscode.setState({ scope: currentScope });
}

function post(message: SettingsToHost): void {
  vscode.postMessage(message);
}

function findRow(key: string): SettingsRowVM | undefined {
  return vm ? allRows(vm).find((r) => r.key === key) : undefined;
}

function render(): void {
  if (!vm) {
    return;
  }
  litRender(renderSettings(vm, addRegistry, registryError, refreshing), root);
  // lit renders synchronously, so an open editor is measurable before paint —
  // see sizePatternEdit, which owns the one-sizing-path invariant.
  const editor = root.querySelector<HTMLInputElement>('.pattern-edit');
  if (editor) {
    sizePatternEdit(editor);
  }
}

/** Rebuilds the last-known-good snapshot (main.ts's revert-on-rejection
 *  source) from a freshly-arrived or freshly-cached ready state. Shared by
 *  handleState and the cache-hit scope-switch path so both keep it in sync
 *  with whatever `vm` is currently showing. */
function snapshotLastGood(
  state: SettingsState,
): Map<string, { value: string | null; set: boolean }> {
  return new Map(allRows(state).map((r) => [r.key, { value: r.value, set: r.set }]));
}

/** Keeps a row's optimistic `value` and its derived `modified` state-bar flag
 *  in sync at every commit site — setting `row.value` alone (the previous
 *  pattern) left `modified` showing whatever the last server VM computed
 *  until the write's own confirmation rebuilt the row from scratch. Every
 *  caller of this commits through `grim config set` (never `unset`), so the
 *  row optimistically becomes `set` too — matching isModified's requirement
 *  that an unset row never shows modified (item 4). */
function setRowValue(row: SettingsRowVM, value: string): void {
  row.value = value;
  row.set = true;
  row.modified = isModified(row.set, value, row.default);
}

// --- Value commits ---

function commitValue(key: string, value: string): void {
  if (!vm) {
    return;
  }
  const row = findRow(key);
  if (row) {
    row.status = 'saving';
    delete row.errorMessage;
  }
  awaitingConfirm += 1;
  post({ type: 'setValue', scope: currentScope, key, value });
  render();
}

function scheduleCommit(key: string, value: string): void {
  const existing = debounceTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      commitValue(key, value);
    }, 400),
  );
}

/** Commits early only when a debounce is actually pending — a blur that lands
 *  after the timer already fired (and already committed) is a no-op, so it
 *  doesn't resend an identical value. */
function flushCommit(key: string, value: string): void {
  const existing = debounceTimers.get(key);
  if (!existing) {
    return;
  }
  clearTimeout(existing);
  debounceTimers.delete(key);
  commitValue(key, value);
}

function setRowError(key: string, message: string): void {
  const row = findRow(key);
  if (row) {
    row.status = 'error';
    row.errorMessage = message;
    render();
  }
}

// --- Registry form ---

/** Brings the just-opened form fully into view, END included. The registry
 *  table sits well down a scrollable panel, so a form appended below the last
 *  row routinely opens off-screen and the click looks like it did nothing.
 *
 *  `scrollIntoView` alone is not enough: `block: 'nearest'` top-aligns an
 *  element taller than the viewport, which is exactly the edit form with both
 *  repeaters open — the Save button stayed below the fold. So the minimal
 *  scroll runs first, then an explicit nudge brings the bottom edge up,
 *  clamped so it can never push the form's own title off the top. lit renders
 *  synchronously, so the node is measurable by the time this runs. */
function revealRegistryForm(): void {
  const form = root.querySelector('.add-registry-form');
  if (!form) {
    return;
  }
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const rect = form.getBoundingClientRect();
  const delta = revealScrollDelta(rect.top, rect.bottom, window.innerHeight);
  if (delta > 0) {
    window.scrollBy({ top: delta, behavior: 'smooth' });
  }
}

function openAddRegistry(): void {
  addRegistry = { ...CLOSED_ADD_REGISTRY, open: true };
  render();
  revealRegistryForm();
}

/** Opens the same form seeded from an existing row, named by the clicked button
 *  rather than by the draft (whose alias field is readonly in this mode).
 *
 *  Refuses while a form is already open. The panel has ONE form slot — which is
 *  why the "Add Registry…" button hides whenever it is occupied (render.ts) —
 *  and every pencil is that same entry point: seeding the form from another row
 *  would discard every pattern typed into the open one without a word. A row
 *  that vanished between render and click (another scope's write reposted
 *  state) and a legacy alias-less row (editRegistryUI refuses it) both do
 *  nothing at all. */
function openEditRegistry(alias: string): void {
  if (addRegistry.open) {
    registryError = 'Finish or cancel the open registry form first.';
    render();
    return;
  }
  const row = vm?.registries.find((r) => r.alias === alias);
  const next = row ? editRegistryUI(row) : null;
  if (!next) {
    return;
  }
  registryError = null;
  addRegistry = next;
  render();
  revealRegistryForm();
}

function closeAddRegistry(): void {
  addRegistry = CLOSED_ADD_REGISTRY;
  pendingRegistryAlias = null;
  render();
}

function setDraftPatterns(field: 'include' | 'exclude', patterns: string[]): void {
  addRegistry = { ...addRegistry, draft: { ...addRegistry.draft, [field]: patterns } };
  render();
}

/** Folds a repeater input's text into the draft list and reports which list it
 *  touched, so the caller can put focus back there. The in-place editor and the
 *  add box are the same control class with the same commit triggers; only an
 *  `index` tells them apart, and editing writes back at that position so a
 *  pattern keeps its place in a list whose order the user can see. The
 *  trim-and-drop-empty rule itself lives with appendPattern/replacePattern.
 *
 *  A duplicate is REFUSED rather than dropped: the typed text stays put and the
 *  form's error line says why, where eating it silently read as a bug. */
function commitPattern(input: HTMLInputElement): 'include' | 'exclude' | null {
  const field = input.dataset['patternField'];
  // A focusout can still arrive for an input a render already removed (Escape,
  // or the commit that input just made). Replaying it would re-apply an edit at
  // an index the list has since shifted — deleting a neighbour, not a twin.
  if (!isPatternField(field) || !input.isConnected) {
    return null;
  }
  const index = input.dataset['index'];
  const result =
    index === undefined
      ? appendPattern(addRegistry.draft[field], input.value)
      : replacePattern(addRegistry.draft[field], Number(index), input.value);
  if (!result.ok) {
    addRegistry = { ...addRegistry, error: DUPLICATE_PATTERN_ERROR };
    render();
    return field;
  }
  if (index === undefined) {
    input.value = '';
  }
  addRegistry = { ...addRegistry, editingPattern: null };
  delete addRegistry.error; // an accepted pattern retires the duplicate banner
  setDraftPatterns(field, result.patterns);
  return field;
}

/** The trailing add box of one repeater — where focus belongs once a commit has
 *  torn the in-place editor out of the DOM. Without it every commit path leaves
 *  focus on `<body>`, and a keyboard user resumes from the top of the panel. */
function focusPatternAdd(field: 'include' | 'exclude'): void {
  root
    .querySelector<HTMLInputElement>(
      `.pattern-input[data-pattern-field="${field}"]:not(.pattern-edit)`,
    )
    ?.focus();
}

/** Puts focus back on the form's title (tabindex="-1") after a rejected save.
 *  The form was `inert` while the write was in flight, which had already thrown
 *  focus out to `<body>`; the title is the one focusable anchor above the error
 *  the user now has to read. */
function focusRegistryForm(): void {
  root.querySelector<HTMLElement>('.add-registry-form .form-title')?.focus();
}

/** Widths the in-place editor to its own text — the ONLY place that does.
 *  Called from render() when one is open and on every keystroke, so the box
 *  tracks the text and the chips after it flow rather than jump. `ch` is exact
 *  per glyph in the monospace face the editor renders in. */
function sizePatternEdit(input: HTMLInputElement): void {
  input.style.width = `${Math.max(input.value.length, 1)}ch`;
}

/** Opens one chip as a text box. The previous edit commits first, so clicking
 *  straight from one chip to another never silently discards what was typed. */
function openPatternEdit(field: 'include' | 'exclude', index: number): void {
  const pending = root.querySelector<HTMLInputElement>('.pattern-edit');
  if (pending) {
    commitPattern(pending);
  }
  addRegistry = { ...addRegistry, editingPattern: { field, index } };
  render();
  const input = root.querySelector<HTMLInputElement>('.pattern-edit');
  input?.focus();
  input?.select();
}

/** Re-reads an edit's `previous` off the row as the VM holds it NOW. The
 *  snapshot taken when the form opened goes stale the moment an unrelated
 *  repost replaces `vm` — an external grimoire.toml edit, say — and the host
 *  omits `--clear-include`/`--clear-exclude` whenever `previous` says the list
 *  was already empty, so a stale one lets patterns added behind the form
 *  survive a save that showed an empty list. Every other field is
 *  last-write-wins; this makes the clear-to-empty case match. Falls back to the
 *  snapshot when the row is gone, and produces identical argv whenever nothing
 *  changed externally. */
function withLivePrevious(ui: AddRegistryUI): AddRegistryUI {
  const { mode } = ui;
  if (mode.kind !== 'edit') {
    return ui;
  }
  const row = vm?.registries.find((r) => r.alias === mode.alias);
  if (!row) {
    return ui;
  }
  return {
    ...ui,
    mode: {
      ...mode,
      previous: {
        include: row.include,
        exclude: row.exclude,
        default: row.default,
        insecure: row.insecure,
      },
    },
  };
}

function submitAddRegistry(): void {
  // In-flight guard: without it, a rapid resubmit (e.g. editing the alias and
  // clicking again before the host replies) overwrites `pendingRegistryAlias`
  // with the second alias, so the FIRST submission's eventual writeError no
  // longer matches anything in handleWriteError and is silently dropped.
  if (!addRegistryDraftValid(addRegistry.draft) || pendingRegistryAlias !== null) {
    return;
  }
  const message = registrySubmitMessage(currentScope, withLivePrevious(addRegistry));
  pendingRegistryAlias = message.alias;
  addRegistry = { ...addRegistry, saving: true, editingPattern: null };
  delete addRegistry.error; // a fresh attempt starts without the last one's banner
  post(message);
  render();
}

// --- Message handling ---

function applyReloadedFade(keys: string[]): void {
  clearTimeout(reloadedFadeTimer);
  reloadedFadeTimer = setTimeout(() => {
    if (!vm) {
      return;
    }
    let changed = false;
    for (const row of allRows(vm)) {
      if (keys.includes(row.key) && row.status === 'reloaded') {
        row.status = 'idle';
        changed = true;
      }
    }
    if (changed) {
      render();
    }
  }, 2500);
}

function handleState(next: SettingsState): void {
  const { selfTriggered: countSelfTriggered, next: remainingConfirms } =
    consumeAwaitingConfirm(awaitingConfirm);
  const selfTriggered = countSelfTriggered || pendingRegistryAlias !== null;
  const prev = vm;
  if (!selfTriggered && prev && prev.phase === 'ready' && next.phase === 'ready') {
    const keys = reloadedKeys(prev, next);
    if (keys.length > 0) {
      for (const row of allRows(next)) {
        if (keys.includes(row.key)) {
          row.status = 'reloaded';
        }
      }
      applyReloadedFade(keys);
    }
  }
  awaitingConfirm = remainingConfirms;
  if (pendingRegistryAlias !== null) {
    pendingRegistryAlias = null;
    addRegistry = CLOSED_ADD_REGISTRY;
  }
  registryError = null;
  refreshing = false;
  vm = next;
  scopeCache.set(next.scope, next);
  if (vm.phase === 'ready') {
    lastGoodValues = snapshotLastGood(vm);
  }
  render();
}

function handleWriteError(scope: Scope, key: string, message: string): void {
  if (!vm || vm.scope !== scope) {
    return;
  }
  const row = findRow(key);
  if (row) {
    const lastGood = lastGoodValues.get(key);
    row.value = lastGood?.value ?? row.value;
    row.set = lastGood?.set ?? row.set;
    row.modified = row.value !== row.default;
    setRowError(key, message);
    return;
  }
  if (pendingRegistryAlias === key) {
    pendingRegistryAlias = null;
    addRegistry = { ...addRegistry, error: message, saving: false };
    render();
    focusRegistryForm();
    return;
  }
  // Neither a config row nor the pending add-registry submission matched —
  // a rejected remove/set-default click (registryRmArgs/registryUseArgs are
  // keyed by alias, which is neither) had nowhere else to surface; show it as
  // a transient banner over the registries table instead of silently
  // swallowing it.
  registryError = message;
  render();
}

window.addEventListener('message', (event: MessageEvent<HostToSettings>) => {
  const message = event.data;
  if (message.type === 'state') {
    handleState(message.state);
  } else if (message.type === 'writeError') {
    handleWriteError(message.scope, message.key, message.message);
  }
});

// --- Event delegation ---

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) {
    return;
  }
  const action = target.dataset['action'];
  switch (action) {
    case 'set-scope': {
      const scope = target.dataset['scope'] as Scope | undefined;
      if (scope && scope !== currentScope) {
        currentScope = scope;
        persist();
        closeAddRegistry();
        debounceTimers.forEach((t) => clearTimeout(t));
        debounceTimers.clear();
        awaitingConfirm = 0;
        // Cache hit: show the previously-seen VM for this scope immediately,
        // same template shape lit already has live DOM for, so it patches
        // rows in place instead of tearing the form down (item 3). No cache
        // yet (first visit to this scope this session) falls back to the
        // 'loading' placeholder — see resolveScopeSwitch's doc.
        const decision = resolveScopeSwitch(scope, scopeCache.get(scope), vm);
        vm = decision.vm;
        refreshing = decision.refreshing;
        if (vm) {
          if (vm.phase === 'ready') {
            lastGoodValues = snapshotLastGood(vm);
          }
          render();
        }
        post({ type: 'switchScope', scope });
      }
      break;
    }
    case 'toggle-bool': {
      const key = target.dataset['key'];
      const row = key ? findRow(key) : undefined;
      if (row) {
        const next = row.value === 'true' ? 'false' : 'true';
        setRowValue(row, next);
        commitValue(row.key, next);
      }
      break;
    }
    case 'toggle-chip': {
      const key = target.dataset['key'];
      const value = target.dataset['value'];
      const row = key ? findRow(key) : undefined;
      if (row && value !== undefined) {
        const current = splitList(row.value);
        const next = current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value];
        const joined = joinList(next);
        setRowValue(row, joined);
        commitValue(row.key, joined);
      }
      break;
    }
    case 'remove-chip': {
      const key = target.dataset['key'];
      const value = target.dataset['value'];
      const row = key ? findRow(key) : undefined;
      if (row && value !== undefined) {
        const joined = joinList(splitList(row.value).filter((v) => v !== value));
        setRowValue(row, joined);
        commitValue(row.key, joined);
      }
      break;
    }
    case 'discard': {
      const key = target.dataset['key'];
      const row = key ? findRow(key) : undefined;
      if (row) {
        row.value = row.default;
        row.set = false;
        row.modified = false;
        row.status = 'saving';
        awaitingConfirm += 1;
        post({ type: 'unsetValue', scope: currentScope, key: row.key });
        render();
      }
      break;
    }
    case 'remove-pattern': {
      const field = target.dataset['patternField'];
      const index = target.dataset['index'];
      if (isPatternField(field) && index !== undefined) {
        // By position, like the in-place editor: removing by value deleted
        // every twin of a repeated glob.
        setDraftPatterns(field, removePattern(addRegistry.draft[field], Number(index)));
      }
      break;
    }
    case 'edit-pattern': {
      const field = target.dataset['patternField'];
      const index = target.dataset['index'];
      if (isPatternField(field) && index !== undefined) {
        openPatternEdit(field, Number(index));
      }
      break;
    }
    case 'open-add-registry':
      openAddRegistry();
      break;
    case 'edit-registry': {
      const alias = target.dataset['alias'];
      if (alias) {
        openEditRegistry(alias);
      }
      break;
    }
    case 'cancel-add-registry':
      closeAddRegistry();
      break;
    case 'submit-add-registry':
      submitAddRegistry();
      break;
    case 'toggle-registry-help': {
      const kind = target.dataset['kind'] as AddRegistryDraft['kind'] | undefined;
      if (kind) {
        addRegistry = { ...addRegistry, helpOpen: toggleRegistryHelp(addRegistry.helpOpen, kind) };
        render();
      }
      break;
    }
    case 'use-registry': {
      const alias = target.dataset['alias'];
      if (alias) {
        registryError = null;
        post({ type: 'useRegistry', scope: currentScope, alias });
        render();
      }
      break;
    }
    case 'unset-default-registry': {
      const alias = target.dataset['alias'];
      if (alias) {
        registryError = null;
        // Demotion goes through the dotted key — grim.ts's editRegistrySteps
        // owns why. Reusing `setValue` needs no new host case, and since
        // `registry.<alias>.default` is not one of the panel's config rows a
        // rejection falls through handleWriteError to the registry banner,
        // where a row-level action belongs.
        post({
          type: 'setValue',
          scope: currentScope,
          key: registryFieldKey(alias, 'default'),
          value: 'false',
        });
        render();
      }
      break;
    }
    case 'remove-registry': {
      const alias = target.dataset['alias'];
      if (alias) {
        registryError = null;
        post({ type: 'removeRegistry', scope: currentScope, alias });
        render();
      }
      break;
    }
    case 'init-project':
      post({ type: 'initProject' });
      break;
    case 'init-global':
      post({ type: 'initGlobal' });
      break;
    case 'install-grim':
      post({ type: 'installGrim' });
      break;
    case 'open-vscode-settings':
      post({ type: 'openVsCodeSettings' });
      break;
    case 'open-config-file':
      post({ type: 'openConfigFile', scope: currentScope });
      break;
    case 'open-docs':
      post({ type: 'openExternal', url: target.dataset['url'] ?? '' });
      break;
  }
});

// Closes an open registry-help tooltip on a click anywhere else (design item
// 4). Document-level, same convention sidebar/main.ts and details/main.ts use
// for their keydown listeners — bubbles up from root's own click handler
// above, which already applied the toggle when the click WAS on the icon, so
// this only ever needs to close, never open.
document.addEventListener('click', (event) => {
  if (addRegistry.helpOpen === null) {
    return;
  }
  if ((event.target as HTMLElement).closest('[data-action="toggle-registry-help"]')) {
    return;
  }
  addRegistry = { ...addRegistry, helpOpen: null };
  render();
});

// Add-registry form field changes: the form is part of the same lit tree as
// everything else (render.ts's renderRegistries takes `addRegistry` as a
// second argument, threaded from here — see render()), so a plain root-level
// delegated listener is all it needs, no separate render target.
root.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.classList.contains('pattern-edit')) {
    // Deliberately not `render()`: that would rebuild the input and drop the
    // caret on every keystroke.
    sizePatternEdit(target);
    return;
  }
  const field = target.dataset['field'];
  if (field === 'alias' || field === 'locator') {
    addRegistry = { ...addRegistry, draft: { ...addRegistry.draft, [field]: target.value } };
    render();
    return;
  }
  handleControlInput(target);
});

root.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  const field = target.dataset['field'];
  if (field === 'kind') {
    addRegistry = {
      ...addRegistry,
      draft: { ...addRegistry.draft, kind: target.value as 'oci' | 'index' },
    };
    render();
    return;
  }
  if (field === 'default' || field === 'insecure') {
    addRegistry = {
      ...addRegistry,
      draft: { ...addRegistry.draft, [field]: (target as HTMLInputElement).checked },
    };
    render();
    return;
  }
  if (target instanceof HTMLSelectElement && target.classList.contains('settings-select')) {
    const key = target.dataset['key'];
    const row = key ? findRow(key) : undefined;
    if (row) {
      setRowValue(row, target.value);
      commitValue(row.key, target.value);
    }
  }
});

/** Text/number/chip-add inputs: debounce ~400ms, flush on blur (focusout — the
 *  bubbling equivalent of blur, used since 'blur' itself doesn't bubble). */
function handleControlInput(target: HTMLInputElement): void {
  const key = target.dataset['key'];
  if (!key) {
    return;
  }
  if (target.classList.contains('chip-input')) {
    // The add-input isn't itself a row value — it's scratch text, debounced
    // the same as text/number and folded into the row's comma-joined list on
    // commit (see flushChipAdd), rather than committed keystroke-by-keystroke.
    scheduleChipAdd(key, target);
    return;
  }
  const row = findRow(key);
  if (!row) {
    return;
  }
  if (row.type === 'integer' && target.value.length > 0 && !isValidInteger(target.value)) {
    row.status = 'error';
    row.errorMessage = 'Must be a whole number, 0 or greater.';
    render();
    return;
  }
  if (row.status === 'error') {
    row.status = 'idle';
    delete row.errorMessage;
  }
  setRowValue(row, target.value);
  render();
  scheduleCommit(key, target.value);
}

function scheduleChipAdd(key: string, target: HTMLInputElement): void {
  const existing = debounceTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      flushChipAdd(target);
    }, 400),
  );
}

/** Validates + commits the free chip editor's ghost add-input (single-char
 *  rule, no commas — model.ts's client-side guards) and clears the input on
 *  success; leaves the typed text in place on rejection so it can be fixed.
 *  Idempotent against a stale pending debounce (clears it first) so a blur
 *  right after the timer already fired can't double-commit. */
function flushChipAdd(target: HTMLInputElement): void {
  const key = target.dataset['key'];
  if (key) {
    const existing = debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      debounceTimers.delete(key);
    }
  }
  const text = target.value;
  if (!key || text.length === 0) {
    return;
  }
  const row = findRow(key);
  if (!row) {
    return;
  }
  if (!isValidChip(text, row.constraints) || chipHasComma(text)) {
    row.status = 'error';
    row.errorMessage = `Separator must be a single character — "${text}" was not applied.`;
    render();
    return;
  }
  const joined = joinList([...splitList(row.value), text]);
  setRowValue(row, joined);
  target.value = '';
  commitValue(key, joined);
}

root.addEventListener(
  'focusout',
  (event) => {
    const target = event.target as HTMLElement;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    if (target.classList.contains('chip-input')) {
      flushChipAdd(target);
      return;
    }
    if (target.classList.contains('pattern-input')) {
      // Only the in-place editor is torn out by the commit's re-render — the
      // add box survives and keeps focus on its own. And only a focus heading
      // NOWHERE needs rescuing: a Tab or a click already picked its target.
      const wasEditor = target.classList.contains('pattern-edit');
      const field = commitPattern(target);
      if (field && wasEditor && event.relatedTarget === null) {
        focusPatternAdd(field);
      }
      return;
    }
    const key = target.dataset['key'];
    if (key && (target.classList.contains('settings-input') || target.type === 'number')) {
      flushCommit(key, target.value);
    }
  },
  true,
);

root.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  // Escape abandons an in-place pattern edit, leaving the stored pattern as it
  // was. Only the in-place editor has something to abandon — the add box's
  // scratch text is not yet part of the draft.
  if (
    event.key === 'Escape' &&
    target instanceof HTMLInputElement &&
    target.classList.contains('pattern-edit')
  ) {
    event.preventDefault();
    const field = target.dataset['patternField'];
    addRegistry = { ...addRegistry, editingPattern: null };
    render();
    if (isPatternField(field)) {
      focusPatternAdd(field);
    }
    return;
  }
  if (event.key !== 'Enter') {
    return;
  }
  if (target instanceof HTMLInputElement && target.classList.contains('chip-input')) {
    event.preventDefault();
    flushChipAdd(target);
    return;
  }
  // Enter inside the add-registry form would otherwise fall through to nothing
  // — the pattern repeater is the one field where it has to mean "add this
  // one", not "submit the form".
  if (target instanceof HTMLInputElement && target.classList.contains('pattern-input')) {
    event.preventDefault();
    const field = commitPattern(target);
    if (field) {
      // Refocusing the add box is what keeps an in-place edit from dropping
      // focus to <body>; committing from the add box refocuses itself.
      focusPatternAdd(field);
    }
  }
});

// A mouse-wheel scroll over a focused number input increments/decrements it
// in every browser by default (item 1) — preventDefault ONLY when the wheel
// event actually lands on the focused number input itself, so page/panel
// scrolling everywhere else (including an unfocused number input) is
// untouched. `{ passive: false }` is required for preventDefault to have any
// effect on a wheel listener.
root.addEventListener(
  'wheel',
  (event) => {
    const target = event.target as HTMLElement;
    const isNumberInput = target instanceof HTMLInputElement && target.type === 'number';
    if (shouldBlockNumberWheel(isNumberInput, target === document.activeElement)) {
      event.preventDefault();
    }
  },
  { passive: false },
);

post({ type: 'ready', scope: currentScope });
