// Pure view-model builders and reducers for the Settings panel. No vscode, no
// DOM — fully unit-testable, same split as webview/model.ts.
import type {
  RegistryFieldState,
  RegistryLocator,
  Scope,
  ScopesVM,
  SettingsControlType,
  SettingsGroupVM,
  SettingsPhase,
  SettingsRegistryFieldVM,
  SettingsRegistryVM,
  SettingsRowConstraints,
  SettingsRowVM,
  SettingsState,
  SettingsToHost,
} from '../protocol';

// Wire shapes (duplicated from grim.ts's ConfigEntry/RegistryEntry — same
// dependency-free convention as webview/model.ts's WireSearchItem: this pure
// module stays independent of the host-only grim.ts at runtime).
export interface WireConfigConstraints {
  item_pattern: string;
  item_width: number;
}

export interface WireConfigEntry {
  key: string;
  value: string | null;
  set: boolean;
  type: string;
  title: string;
  description: string;
  default: string | null;
  values: string[] | null;
  constraints: WireConfigConstraints | null;
}

export interface WireRegistryEntry {
  alias: string | null;
  oci: string | null;
  index: string | null;
  /** Browse filters — additive, so absent on an older grim (see grim.ts's
   *  RegistryEntry). buildRegistryRow normalizes both to `[]`. */
  include?: string[];
  exclude?: string[];
  default: boolean;
  /** Plain-HTTP opt-in — additive, so absent on an older grim (see grim.ts's
   *  RegistryEntry). buildRegistryRow normalizes it to a boolean. */
  insecure?: boolean;
}

const KNOWN_TYPES: readonly SettingsControlType[] = [
  'string',
  'boolean',
  'enum',
  'string-list',
  'string-set',
  'integer',
];

/** Narrows grim's open wire `type` string to the closed set the renderer
 *  knows how to draw a control for; anything else degrades to 'unknown' (spec
 *  §1: never throw on a future type). */
function narrowType(type: string): SettingsControlType | 'unknown' {
  return (KNOWN_TYPES as readonly string[]).includes(type)
    ? (type as SettingsControlType)
    : 'unknown';
}

/** Last dot-segment of a config key ("options.default_registry" -> "default_registry"). */
function shortKey(key: string): string {
  const dot = key.lastIndexOf('.');
  return dot === -1 ? key : key.slice(dot + 1);
}

/** The two config keys whose default is meaningfully null (no static default
 *  value — the behavior falls back to a runtime decision) get a behavioral
 *  caption instead of the generic "Default: …" line (design item 3). */
const NULL_DEFAULT_HINTS: Record<string, string> = {
  default_registry: 'Not set — the registry precedence chain decides.',
  clients:
    'Not set — clients are auto-detected, falling back to all clients when none are detected.',
};

export function defaultHint(key: string, value: string | null): string {
  if (value === null) {
    return NULL_DEFAULT_HINTS[shortKey(key)] ?? 'Not set.';
  }
  return `Default: ${value}`;
}

/** The value an enum dropdown renders selected. A SET row shows its own
 *  value; an UNSET row (value null) must show the key's DEFAULT — never just
 *  the first `values[]` entry (bug: unset "Default view" rendered "flat"
 *  selected — the first enum value — even though the effective default is
 *  "tree"). Only when the default itself is null does this fall back to the
 *  first values entry, purely so *something* renders selected. Shared here
 *  (not per-key) so every enum row, current and future, goes through the
 *  same rule. */
export function enumSelectedValue(
  row: Pick<SettingsRowVM, 'value' | 'default' | 'values'>,
): string | null {
  if (row.value !== null) {
    return row.value;
  }
  if (row.default !== null) {
    return row.default;
  }
  return row.values?.[0] ?? null;
}

/** Row's left-border "modified" accent (design item 3): only meaningful for a
 *  row that's actually SET. An unset row's `value` is always null, which
 *  trivially differs from most non-null defaults — that false-positived the
 *  accent on every unset row with a non-null default (bug: unset "Default
 *  view" showed modified even though nothing overrides it). Idle instead;
 *  the hint line already communicates the default. */
export function isModified(
  set: boolean,
  value: string | null,
  defaultValue: string | null,
): boolean {
  return set && value !== defaultValue;
}

export function buildSettingsRow(entry: WireConfigEntry): SettingsRowVM {
  return {
    key: entry.key,
    title: entry.title,
    description: entry.description,
    type: narrowType(entry.type),
    value: entry.value,
    default: entry.default,
    set: entry.set,
    values: entry.values,
    modified: isModified(entry.set, entry.value, entry.default),
    hint: defaultHint(entry.key, entry.default),
    status: 'idle',
    constraints: entry.constraints
      ? { itemPattern: entry.constraints.item_pattern, itemWidth: entry.constraints.item_width }
      : null,
  };
}

export function buildRegistryRow(entry: WireRegistryEntry): SettingsRegistryVM {
  return {
    alias: entry.alias,
    type: entry.oci !== null ? 'oci' : entry.index !== null ? 'index' : 'unknown',
    locator: entry.oci ?? entry.index ?? '',
    default: entry.default,
    // isArray, not `?? []`: a hand-edited config can make grim report a bare
    // string here, and every downstream reader calls .join()/.map() on it.
    include: Array.isArray(entry.include) ? entry.include : [],
    exclude: Array.isArray(entry.exclude) ? entry.exclude : [],
    // `=== true`, not truthiness: an older grim omits the key entirely, and a
    // hand-edited config can make it report a string.
    insecure: entry.insecure === true,
    legacy: entry.alias === null,
  };
}

/** Fixed group order + membership (design item 2: "Options" / "TUI"). A future
 *  key not in this table still renders — it falls into "Options" rather than
 *  being dropped (frozen/additive tolerance). */
const GROUP_ORDER = ['Options', 'TUI'] as const;
const GROUP_OF: Record<string, (typeof GROUP_ORDER)[number]> = {
  default_registry: 'Options',
  clients: 'Options',
  show_deprecated: 'Options',
  default_view: 'TUI',
  group_by_type: 'TUI',
  tree_separators: 'TUI',
  expand_levels: 'TUI',
};

/** `config list --all` emits one row per registry per field
 *  (`registry.<alias>.oci`, `.include`, …) alongside the fixed `options.*`
 *  keys. Those belong to the Registries table, which reads them from
 *  `registry list` instead — left in, `shortKey` would strip the prefix and
 *  drop every one of them into "Options" as an unlabelled duplicate. Worse for
 *  the two filter lists: their wire type is `string-list`, so renderControl
 *  would hand them the comma-joining chip editor, and editing one there splits
 *  `{tools,libs}/**` into two fragments that no longer compile. */
export function buildGroups(entries: WireConfigEntry[]): SettingsGroupVM[] {
  const byTitle = new Map<string, SettingsRowVM[]>();
  for (const entry of entries) {
    if (entry.key.startsWith('registry.')) {
      continue;
    }
    const title = GROUP_OF[shortKey(entry.key)] ?? 'Options';
    byTitle.set(title, [...(byTitle.get(title) ?? []), buildSettingsRow(entry)]);
  }
  // Empty panels are omitted (CLAUDE.md convention) — a group with no rows
  // (only possible with a partial/test fixture; real grim always returns all 7).
  return GROUP_ORDER.filter((title) => byTitle.has(title)).map((title) => ({
    title,
    rows: byTitle.get(title) ?? [],
  }));
}

export interface SettingsSource {
  scope: Scope;
  scopes: ScopesVM;
  /** True when grim isn't on PATH at all — no context/config call was possible. */
  grimMissing: boolean;
  configPath: string | null;
  configExists: boolean;
  /** See SettingsState.searchScope — the scope Browse is actually searching,
   *  undefined when it isn't known yet. */
  searchScope?: Scope;
  entries: WireConfigEntry[];
  registries: WireRegistryEntry[];
  /** grim's registry-form field metadata, already fetched + mapped host-side
   *  (see SettingsManager.ensureRegistryFields) — threaded straight through
   *  to the VM regardless of phase. */
  registryFields: SettingsRegistryFieldVM[];
  registryEditSupported: boolean;
  grimVersion: string | null;
}

/** The four data-driven empty/init phases; 'loading' and 'error' are
 *  host-constructed states that never call buildSettingsVM at all (same
 *  split as SidebarState.phase vs buildCards). Both scopes gate on
 *  configExists (user-decided 2026-07-17): a config file must never be
 *  implicitly materialized just because the panel was opened, so Global gets
 *  its own empty/init phase mirroring Project's, rather than always reading
 *  as 'ready'. */
export function resolveSettingsPhase(
  source: Pick<SettingsSource, 'scope' | 'scopes' | 'grimMissing' | 'configExists'>,
): SettingsPhase {
  if (source.grimMissing) {
    return 'no-grim';
  }
  if (source.scope === 'project') {
    if (!source.scopes.projectOpen) {
      return 'no-folder';
    }
    if (!source.configExists) {
      return 'project-no-toml';
    }
  } else if (!source.configExists) {
    return 'global-no-toml';
  }
  return 'ready';
}

/** Merges grim's config list + registry list into the active scope's Settings
 *  view model. Both scopes now gate on configExists — see
 *  resolveSettingsPhase's 'project-no-toml'/'global-no-toml' branches. */
export function buildSettingsVM(source: SettingsSource): SettingsState {
  const phase = resolveSettingsPhase(source);
  const ready = phase === 'ready';
  return {
    scope: source.scope,
    phase,
    projectOpen: source.scopes.projectOpen,
    projectName: source.scopes.projectName,
    configPath: source.configExists ? source.configPath : null,
    rawConfigPath: source.configPath,
    ...(source.searchScope !== undefined ? { searchScope: source.searchScope } : {}),
    groups: ready ? buildGroups(source.entries) : [],
    registries: ready ? source.registries.map(buildRegistryRow) : [],
    registryFields: source.registryFields,
    registryEditSupported: source.registryEditSupported,
    grimVersion: source.grimVersion,
  };
}

/** Flat row list across every group — the shape both the renderer's key
 *  function and the reload-diff below iterate. */
export function allRows(state: SettingsState): SettingsRowVM[] {
  return state.groups.flatMap((g) => g.rows);
}

/** Keys whose value differs between two same-scope VMs — used to flag an
 *  unsolicited external refresh (a file-watcher repost, not the response to
 *  this webview's own write) with the "Reloaded from disk" badge. A repost
 *  that merely confirms the webview's own optimistic edit shows no diff worth
 *  flagging, since the value it already displays matches. */
export function reloadedKeys(prev: SettingsState, next: SettingsState): string[] {
  if (prev.scope !== next.scope) {
    return [];
  }
  const prevByKey = new Map(allRows(prev).map((r) => [r.key, r.value]));
  return allRows(next)
    .filter((row) => {
      const prevValue = prevByKey.get(row.key);
      return prevValue !== undefined && prevValue !== row.value;
    })
    .map((row) => row.key);
}

// --- Client-side guards (validated locally, not round-tripped through grim) ---

/** Chip item-shape guard, data-driven off the row's `constraints` (grim's
 *  `ValueConstraints`, advisory-not-authoritative per its own doc — grim's
 *  `config set` predicate is the real gate). `constraints === null` covers
 *  every list key with no per-item shape rule beyond `values` membership
 *  (there are none of those with a free chip editor today) and falls back
 *  to the original single-character rule. An unparseable `itemPattern`
 *  (forward-incompatible regex syntax from a newer grim, or a genuine grim
 *  bug) fails OPEN — this is only a pre-check, so it would rather
 *  under-reject than block a value grim's own validation would accept. */
export function isValidChip(value: string, constraints: SettingsRowConstraints | null): boolean {
  if (constraints === null) {
    return value.length === 1;
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(constraints.itemPattern, 'u');
  } catch {
    return true;
  }
  // ponytail: itemWidth is grim's Unicode DISPLAY width (unicode-width
  // crate); no such measure is wired up client-side, so string length
  // stands in — exact for today's only constrained key (single ASCII
  // separators). Swap in a display-width library if a future key needs
  // wide-character awareness.
  return value.length === constraints.itemWidth && pattern.test(value);
}

/** string-list/string-set wire format is comma-joined — reject a chip value
 *  that would corrupt it. */
export function chipHasComma(value: string): boolean {
  return value.includes(',');
}

/** Integer control guard: non-negative whole numbers only. */
export function isValidInteger(value: string): boolean {
  return /^\d+$/.test(value);
}

/** A mouse-wheel scroll over a FOCUSED number input changes its value in
 *  every browser by default — main.ts's wheel listener must preventDefault
 *  exactly then, never otherwise, so page/panel scroll stays untouched
 *  everywhere else. Pure so the one-line condition is unit-testable without a
 *  DOM (main.ts itself isn't unit-tested — browser-only entry, same as every
 *  other webview main.ts). */
export function shouldBlockNumberWheel(isNumberInput: boolean, isFocused: boolean): boolean {
  return isNumberInput && isFocused;
}

/** Extra margin below the registry form when scrolling it into view. */
export const FORM_REVEAL_MARGIN_PX = 24;

/** How far to scroll so a just-opened registry form is fully visible, in the
 *  same viewport coordinates `getBoundingClientRect` reports. 0 means "already
 *  visible enough, do not scroll".
 *
 *  The clamp is the whole point and is why this is worth extracting: scrolling
 *  by the raw overshoot would push the form's TOP off the viewport whenever the
 *  form is taller than the space below it, so the result never exceeds
 *  `rectTop` — the form's title stays reachable no matter how tall the form
 *  grows. Pure, so that invariant is testable without a DOM (main.ts is a
 *  browser-only entry and is not unit-tested, same as every other main.ts). */
export function revealScrollDelta(
  rectTop: number,
  rectBottom: number,
  viewportHeight: number,
): number {
  const overshoot = rectBottom + FORM_REVEAL_MARGIN_PX - viewportHeight;
  return overshoot <= 0 ? 0 : Math.min(overshoot, Math.max(0, rectTop));
}

export function splitList(value: string | null): string[] {
  return value ? value.split(',').filter((s) => s.length > 0) : [];
}

export function joinList(items: string[]): string {
  return items.join(',');
}

// --- Add-registry form draft (ephemeral webview-only state until submit) ---

export interface AddRegistryDraft {
  alias: string;
  kind: 'oci' | 'index';
  locator: string;
  /** Browse-filter globs, one entry per pattern. Authored here because the
   *  repeatable `--include`/`--exclude` flags — on `registry add` for a new
   *  entry, `registry set` for an existing one — are the only CLI path that
   *  writes a multi-pattern list. */
  include: string[];
  exclude: string[];
  default: boolean;
  /** Only meaningful on the `oci` kind — grim refuses `--insecure` on an index
   *  locator, so the checkbox is absent there and the draft value is ignored
   *  (registrySubmitMessage pins the write to false). Kept across a kind flip
   *  rather than reset, so flipping to Index and back does not silently drop an
   *  opt-in the user already ticked. */
  insecure: boolean;
}

/** Seeds the form from the row being edited. The VM already carries every
 *  field `registry set` can write, so the draft is a straight copy — no
 *  refetch, and the arrays are copied rather than aliased so cancelling an
 *  edit cannot leave the table showing patterns that were never saved.
 *
 *  A `type` of 'unknown' means grim reported an entry with neither locator,
 *  which only a hand-edited config produces; 'index' is the safe landing
 *  because it is what the empty draft picks too, and the user has to fill the
 *  locator in either way before the form will submit. */
export function draftFromRegistry(r: SettingsRegistryVM): AddRegistryDraft {
  return {
    alias: r.alias ?? '',
    kind: r.type === 'oci' ? 'oci' : 'index',
    locator: r.locator,
    include: [...r.include],
    exclude: [...r.exclude],
    default: r.default,
    insecure: r.insecure,
  };
}

// Index locator is the common case (curated catalogs like the hosted
// Grimoire index) — default selection and radio order both put it first.
export const EMPTY_REGISTRY_DRAFT: AddRegistryDraft = {
  alias: '',
  kind: 'index',
  locator: '',
  include: [],
  exclude: [],
  default: false,
  insecure: false,
};

export function addRegistryDraftValid(draft: AddRegistryDraft): boolean {
  return draft.alias.trim().length > 0 && draft.locator.trim().length > 0;
}

/** Maps the form's selected type to grim's tagged RegistryLocator union. */
export function draftToLocator(draft: AddRegistryDraft): RegistryLocator {
  return draft.kind === 'oci' ? { oci: draft.locator.trim() } : { index: draft.locator.trim() };
}

/** Locator field placeholder, per selected type (design item 3) — switching
 *  type swaps this without touching the user's already-typed locator text. */
export const LOCATOR_PLACEHOLDER: Record<AddRegistryDraft['kind'], string> = {
  index: 'https://example.com/index.json — or — git repository URL',
  oci: 'ghcr.io/org',
};

// --- Own-write vs. external-edit disambiguation (main.ts's `awaitingConfirm`) ---

/** Decides whether an incoming 'state' post is this webview's OWN write
 *  confirming (vs. a genuine external file change), and what the credit
 *  count becomes afterward. A repost consumes at most ONE credit — earlier
 *  this unconditionally zeroed the whole counter on every post, which
 *  mislabeled a second in-flight write's own confirmation as an external
 *  "Reloaded from disk" edit whenever two edits in the same scope overlapped
 *  (write B queues behind write A's grim round trip; A's confirmation used
 *  to wipe out the credit B still needed). Still coarse (a count, not a
 *  per-key set): a genuinely external edit that lands while 2+ self-writes
 *  are still queued can still consume a credit meant for one of them — a
 *  narrower, pre-existing gap than the one this fixes. */
export function consumeAwaitingConfirm(awaitingConfirm: number): {
  selfTriggered: boolean;
  next: number;
} {
  return { selfTriggered: awaitingConfirm > 0, next: Math.max(0, awaitingConfirm - 1) };
}

/** What main.ts should show the instant a Project/Global switch happens,
 *  before the host's fresh fetch for the target scope confirms (item 3: no
 *  flicker on scope switch). The prior bug flipped straight to a structurally
 *  different 'loading' template on EVERY switch — renderSettingsBody's phase
 *  switch renders 'ready' (groups/rows/registries) and 'loading' (a lone
 *  progress ring) as entirely different template shapes, so lit-html tore
 *  the whole form down and rebuilt it twice per switch (down, then back up
 *  once the fetch landed) instead of patching in place.
 *
 *  A scope visited before this session has a cached VM in the SAME
 *  'ready'/'error'/etc. shape the live DOM already reflects — showing it
 *  immediately lets lit-html's keyed `repeat()` (row keys are the config key,
 *  not scope-prefixed — identical set of keys in every scope) patch each
 *  row's text/value in place. `refreshing` is a non-structural flag
 *  (render.ts dims the form) the caller clears once the host's confirmation
 *  for the target scope lands — it never changes the template shape itself.
 *
 *  A scope with nothing cached yet (first visit this session) has no live
 *  'ready' DOM to patch into, so falling back to the 'loading' placeholder is
 *  a genuine state transition — allowed per spec (empty/init states may
 *  swap; the flicker requirement is about repeated form<->form switches, and
 *  this only ever happens once per scope per session). */
export function resolveScopeSwitch(
  targetScope: Scope,
  cached: SettingsState | undefined,
  current: SettingsState | null,
): { vm: SettingsState | null; refreshing: boolean } {
  if (cached) {
    return { vm: cached, refreshing: true };
  }
  if (current) {
    return { vm: { ...current, scope: targetScope, phase: 'loading' }, refreshing: false };
  }
  return { vm: current, refreshing: false };
}

/** Which entry the one registry form is writing. One form serves both modes:
 *  the fields are the same five, the validation is the same, and grim's own
 *  `registry set` mirrors `registry add` flag for flag.
 *
 *  A TAG, not a pair of nullables. The alias being edited and the row's state
 *  at open are meaningless apart — either both are known (edit) or neither is
 *  (add) — and as two independent `string | null` / `{…} | null` fields the
 *  half-set combinations were representable and silently wrong: an alias with
 *  no previous state posted `addRegistry` for an entry that already exists,
 *  and previous state with no alias posted `editRegistry` named by whatever
 *  the readonly draft field happened to hold. */
export type AddRegistryMode =
  | { kind: 'add' }
  /** `previous` is captured at OPEN, not re-read at submit: an unrelated state
   *  repost can replace the VM while the form is up, and the host uses it to
   *  decide whether the subtractive steps are needed at all. */
  | { kind: 'edit'; alias: string; previous: RegistryFieldState };

/** Ephemeral, webview-only UI state for the add-registry form — threaded into
 *  render.ts as a second argument alongside the host-posted SettingsState,
 *  the same split webview/model.ts's CardFilter uses alongside SidebarState. */
export interface AddRegistryUI {
  open: boolean;
  draft: AddRegistryDraft;
  error?: string;
  /** Which per-radio info tooltip is open, if any (design item 4) — `null`
   *  when neither is. Only one is ever open at a time. */
  helpOpen: AddRegistryDraft['kind'] | null;
  /** Only `open: true` makes this meaningful — one form, so an edit and an add
   *  can never both be in progress. */
  mode: AddRegistryMode;
  /** A submit is in flight. Every control goes disabled and the submit button
   *  becomes a spinner, because a registry write is several grim invocations
   *  behind a per-scope queue and a lock retry — without this the form looks
   *  frozen, and a second click is silently swallowed by submitAddRegistry's
   *  in-flight guard. Cleared by the state repost (success) or the writeError
   *  (failure); both already reset this object. */
  saving: boolean;
  /** Which pattern chip is open as a text box, by list and position, or
   *  `null` when none is. Editing by INDEX rather than by value, because a
   *  half-typed pattern is routinely equal to another one in the list and
   *  position is what the user is pointing at. Draft-only, like the rest of
   *  this object — nothing reaches grim until the form is submitted. */
  editingPattern: { field: 'include' | 'exclude'; index: number } | null;
}

export const CLOSED_ADD_REGISTRY: AddRegistryUI = {
  open: false,
  draft: EMPTY_REGISTRY_DRAFT,
  helpOpen: null,
  mode: { kind: 'add' },
  saving: false,
  editingPattern: null,
};

/** Opens the form on an existing row, seeding the draft and capturing what to
 *  diff against at submit. `null` for a legacy alias-less row: grim has no
 *  name to address it by, so it carries no edit button and there is no
 *  edit-mode state that could describe it. */
export function editRegistryUI(row: SettingsRegistryVM): AddRegistryUI | null {
  if (row.alias === null) {
    return null;
  }
  return {
    open: true,
    draft: draftFromRegistry(row),
    helpOpen: null,
    saving: false,
    editingPattern: null,
    mode: {
      kind: 'edit',
      alias: row.alias,
      previous: {
        include: [...row.include],
        exclude: [...row.exclude],
        default: row.default,
        insecure: row.insecure,
      },
    },
  };
}

/** The write the open form submits. One construction for both modes — the six
 *  shared fields were duplicated across two literals, where a field added to
 *  one and forgotten in the other is a silent data loss on that path. */
export function registrySubmitMessage(
  scope: Scope,
  ui: AddRegistryUI,
): Extract<SettingsToHost, { type: 'addRegistry' | 'editRegistry' }> {
  const { draft, mode } = ui;
  const fields = {
    scope,
    locator: draftToLocator(draft),
    include: draft.include,
    exclude: draft.exclude,
    default: draft.default,
    // The one field the draft cannot be trusted for: grim rejects `--insecure`
    // on an index locator (exit 65), and the draft deliberately REMEMBERS a
    // ticked box across a kind flip. Pinned here rather than in the kind
    // handler so every submit path goes through the same rule.
    insecure: draft.kind === 'oci' && draft.insecure,
  };
  return mode.kind === 'edit'
    ? { type: 'editRegistry', alias: mode.alias, ...fields, previous: mode.previous }
    : { type: 'addRegistry', alias: draft.alias.trim(), ...fields };
}

// --- Pattern repeater (draft-only; nothing here reaches grim until submit) ---

/** Outcome of a pattern add/edit. A duplicate is REPORTED rather than applied:
 *  dropping the typed value (add) or collapsing the edited chip into its twin
 *  (edit) both read as the form eating input, so the caller surfaces
 *  {@link DUPLICATE_PATTERN_ERROR} on the form's existing error line instead. */
export type PatternResult = { ok: true; patterns: string[] } | { ok: false; reason: 'duplicate' };

export const DUPLICATE_PATTERN_ERROR = 'That pattern is already in the list.';

/** Folds the repeater's scratch text into the list. Trim-and-drop-empty is the
 *  whole client-side rule: grim owns glob validity and rejects an
 *  uncompilable pattern with exit 65, and a comma is legal ALTERNATION here,
 *  so neither the row chip editor's single-character check nor its comma
 *  refusal applies. An empty box adds nothing and is not an error. */
export function appendPattern(patterns: string[], value: string): PatternResult {
  const text = value.trim();
  if (text === '') {
    return { ok: true, patterns };
  }
  if (patterns.includes(text)) {
    return { ok: false, reason: 'duplicate' };
  }
  return { ok: true, patterns: [...patterns, text] };
}

/** Puts `value` at `index`, or removes that entry when the edit was cleared.
 *  Out of range is a no-op — an index past the end would otherwise punch a
 *  sparse hole into the list. */
export function replacePattern(patterns: string[], index: number, value: string): PatternResult {
  if (index < 0 || index >= patterns.length) {
    return { ok: true, patterns };
  }
  const text = value.trim();
  const rest = patterns.filter((_, i) => i !== index);
  if (text === '') {
    return { ok: true, patterns: rest };
  }
  if (rest.includes(text)) {
    return { ok: false, reason: 'duplicate' };
  }
  const next = [...patterns];
  next[index] = text;
  return { ok: true, patterns: next };
}

/** Drops one entry BY INDEX, matching how the in-place editor addresses the
 *  same list: removing by value deleted every twin of a repeated glob. */
export function removePattern(patterns: string[], index: number): string[] {
  return patterns.filter((_, i) => i !== index);
}

/** Guards the `data-pattern-field` attribute the delegated click/commit
 *  handlers read — the only thing standing between a typo'd attribute and
 *  indexing the draft with it. */
export function isPatternField(v: unknown): v is 'include' | 'exclude' {
  return v === 'include' || v === 'exclude';
}

/** Click-toggle transition for a per-radio info icon (design item 4):
 *  clicking the icon whose tooltip is already open closes it; clicking the
 *  OTHER icon switches to it — only one tooltip is ever open at a time.
 *  Clicking anywhere else closes it outright, which needs no helper (it's
 *  always just `null`). */
export function toggleRegistryHelp(
  current: AddRegistryDraft['kind'] | null,
  clicked: AddRegistryDraft['kind'],
): AddRegistryDraft['kind'] | null {
  return current === clicked ? null : clicked;
}
