// Pure view-model builders and reducers for the Settings panel. No vscode, no
// DOM — fully unit-testable, same split as webview/model.ts.
import type {
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
  default: boolean;
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
  clients: 'Not set — clients are auto-detected, falling back to all clients when none are detected.',
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
export function enumSelectedValue(row: Pick<SettingsRowVM, 'value' | 'default' | 'values'>): string | null {
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
export function isModified(set: boolean, value: string | null, defaultValue: string | null): boolean {
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

export function buildGroups(entries: WireConfigEntry[]): SettingsGroupVM[] {
  const byTitle = new Map<string, SettingsRowVM[]>();
  for (const entry of entries) {
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
  default: boolean;
}

// Index locator is the common case (curated catalogs like the hosted
// Grimoire index) — default selection and radio order both put it first.
export const EMPTY_REGISTRY_DRAFT: AddRegistryDraft = {
  alias: '',
  kind: 'index',
  locator: '',
  default: false,
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
}

export const CLOSED_ADD_REGISTRY: AddRegistryUI = {
  open: false,
  draft: EMPTY_REGISTRY_DRAFT,
  helpOpen: null,
};

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
