// Message protocol between the extension host and the webviews. Shared,
// dependency-free (no vscode / DOM imports) so both sides and the tests can
// import it.

export type Scope = 'project' | 'global';

export type ArtifactKind = 'skill' | 'rule' | 'agent' | 'mcp' | 'bundle';

export type RowState = 'not-installed' | 'installed' | 'outdated' | 'deprecated';

/** Which resolution branch produced the grim binary
 *  (ScopeService.resolvedExecutable().origin). Inlined here — structurally
 *  identical to views/grimInfo.ts's GrimOrigin — rather than imported, so this
 *  shared webview module stays free of host-only `views/` imports (same
 *  convention as WireSearchItem duplicating grim.ts's SearchItem). */
export type GrimOrigin = 'setting' | 'PATH' | 'bundled' | 'missing';

export interface InstallVM {
  scope: Scope;
  /** Declared version/tag shown on the chip (e.g. "1.4.2", "latest"). */
  version: string | null;
  /** Whether this install surfaces an update — model.ts's
   *  `computeUpdateAvailable`, NOT `state === 'outdated'/'stale'`: grim's verdict
   *  `--check` decides when there is one (fresh this round or remembered from
   *  the last checked one), and the local lock state is only the fallback proxy
   *  when there is none. */
  updateAvailable: boolean;
  clients: string[];
  /** grim's raw state (installed|stale|modified|missing|outdated). */
  state: string;
  kind: string;
  name: string;
  /** Bundle repos providing this member (status `source` "bundle: …"); empty for direct installs. */
  viaBundles: string[];
  /** True when the lock has no pinned entry (grim `pinned: null`) — the install
   *  tracks a floating tag rather than an exact pin. */
  floating?: boolean;
  /** Clients the project's config targets but this install has no recorded
   *  output for (grim status `clients_missing`, desired − recorded). Absent/[]
   *  means no drift, including when `[options].clients` is unset (autodetect —
   *  grim never diffs against live detection there). */
  clientsMissing?: string[];
  /** Clients this install has a recorded output for but the config no longer
   *  targets (grim status `clients_extra`, recorded − desired). Same [] /
   *  absence semantics as {@link clientsMissing}. */
  clientsExtra?: string[];
  /** Per-status-item deprecation notice, populated only under `--check` (null
   *  otherwise) — buildInstalledCards' fallback source when the artifact isn't
   *  present in the browse catalog snapshot. */
  deprecated?: string | null;
  /** Publisher-named successor for {@link deprecated}, same population rule. */
  replacedBy?: string | null;
}

/** A card's registry attribution — the `{alias, locator}` grim's search JSON
 *  carries per row. The locator is the configured entry's own value, which for
 *  an index is a URL no repo starts with; that is exactly why the alias cannot
 *  be re-derived from the repo. */
export interface CardSource {
  alias: string | null;
  locator: string;
}

export interface CardVM {
  repo: string;
  name: string;
  kind: ArtifactKind | null;
  description: string | null;
  registryHost: string;
  /** Best-known latest version (search.version ?? latest_tag). */
  latestVersion: string | null;
  state: RowState;
  deprecated: string | null;
  replacedBy: string | null;
  installs: InstallVM[];
  /** The configured registry entry this row was browsed from, as grim's search
   *  JSON attributes it. Absent on installed-only cards (grim `status` carries
   *  no registry attribution — its own `source` field means "direct" vs "via
   *  bundle") and on a grim that predates the field; both fall back to
   *  longest-configured-prefix attribution, which is grim's own rule for a row
   *  it cannot attribute. */
  source?: CardSource;
  /** True when the card's registry host is one the user is authenticated to
   *  (a private registry) — renders a lock glyph. Absent/false = public. */
  privateRegistry?: boolean;
  /** data: URI of the artifact logo when the details cache has one (prefetched
   *  or previously opened); shown in place of the codicon tile. */
  logoUri?: string | null;
}

/** One configured registry, as the scope Browse actually searched reports it
 *  (grim `context.registries[]`). The catalog groups and the tree key on these,
 *  NOT on the repo's host: two registries can share a host and differ only by
 *  namespace, and the name the user gave a registry in grimoire.toml is the
 *  name they expect to see. */
export interface RegistryVM {
  /** Configured alias; null when the entry has none (grim allows that). */
  alias: string | null;
  /** grim's `url`: for a `registry` entry the host + namespace prefix a repo
   *  starts with ("localhost:5050/grimoire"); for an `index` entry the index's
   *  own URL ("https://index.grimoire.rs"), which no repo starts with. */
  oci: string;
  /** grim's `kind`. Only a `registry` entry can claim a repo by prefix — an
   *  index serves rows from arbitrary hosts, and `grim search` does not say
   *  which source served which row (see registryFor). */
  kind: 'registry' | 'index';
  isDefault: boolean;
  /** A stored credential exists for this registry (grim `authenticated`). */
  authenticated?: boolean;
}

export interface ScopesVM {
  /** A workspace folder is open (project scope can exist). */
  projectOpen: boolean;
  /** grimoire.toml found for the project scope. */
  projectConfigured: boolean;
  projectName: string | null;
}

export interface SidebarState {
  phase: 'loading' | 'ready' | 'error' | 'no-grim';
  /** Which internal tab the render functions draw: Browse, the outdated Updates
   *  list, or Installed (with its project/global toggle). The host always posts
   *  'browse' (its `items` are the browse cards); the webview re-stamps the
   *  active tab and slices `items` from {@link installedItems} client-side
   *  (model.ts viewForTab) before rendering. */
  mode: 'browse' | 'updates' | 'installed';
  query: string;
  items: CardVM[];
  /** The merged installed set, both scopes (buildInstalledCards). The Updates
   *  tab is its `hasUpdate` slice — NOT `state === 'outdated'`, which shadows an
   *  updatable artifact the moment it is also deprecated (model.ts rowState);
   *  the Installed tab applies the SCOPE toggle client-side. Rides every post so
   *  tab switches never need a host round-trip. */
  installedItems: CardVM[];
  scopes: ScopesVM;
  /** The registries the browse search actually resolved — from the SEARCHED
   *  scope's context (project when it is configured, else global), not global
   *  alone: a project declaring its own `[[registries]]` browses those, and
   *  reporting global's set made the view describe registries it never read. */
  registries: RegistryVM[];
  /** Host of the default registry, shown in the loading footer. Null when
   *  unknown (first load, before any snapshot). */
  defaultRegistry?: string | null;
  syncedAt: number | null;
  now: number;
  error?: string;
  /** Set when the catalog loaded but `grim status` did not, so install state is
   *  UNKNOWN — not empty. Carries the reason (a too-old binary, a failed status
   *  call). Browse still renders its catalog cards, but every install/update
   *  affordance is suppressed rather than claiming "Install" on an artifact
   *  that may well be installed, and Updates/Installed say so instead of
   *  reading as empty. */
  installStateUnknown?: string;
  /** Why {@link installStateUnknown} is set (the null scope's unknownReason).
   *  A sibling field rather than widening `installStateUnknown` into an object:
   *  the message is the banner's display text, this is the control signal for
   *  which remedy the banner may offer. Only `'too-old'` is fixable by
   *  installing a current grim. Absent when the reason isn't known. */
  installStateUnknownReason?: 'too-old' | 'status-failed' | 'probe-failed';
  /** How the resolved grim was found (ScopeService.resolvedExecutable().origin),
   *  set alongside {@link installStateUnknownReason}. The banner offers "Install
   *  grim" only for a too-old binary the extension can actually replace —
   *  `'bundled'`/`'missing'`; a `'PATH'`/`'setting'` grim would keep being
   *  preferred (resolveExecutable prefers it), so the download changes nothing
   *  and the banner offers "Show grim Info" instead. Absent when not known. */
  installStateUnknownOrigin?: GrimOrigin;
}

export type SidebarToHost =
  | { type: 'ready' }
  | { type: 'search'; query: string }
  | { type: 'refresh' }
  | { type: 'install'; ref: string; scope: Scope }
  | { type: 'uninstall'; kind: string; name: string; scope: Scope }
  | { type: 'update'; kind: string; name: string; scope: Scope }
  /** The view state changed (a title-bar action, or a click inside the view) —
   *  the host mirrors it into context keys so the title bar can swap each
   *  toggle's icon. State itself stays in the webview. */
  | { type: 'viewFlags'; flags: ViewFlags }
  /** The user actively switched a view control. Sent ONLY from a title-bar
   *  action — never from a twisty click, a tab switch or a boot — so the stored
   *  preference records deliberate choices and nothing else. The host writes it
   *  to globalState; see {@link ViewOptions}. */
  | { type: 'viewPrefs'; view: ViewOptions }
  /** One card-menu "Switch to <replacedBy>" entry: install the deprecated
   *  artifact's named successor in `scope`, then uninstall the old one. Per
   *  scope (each installed row has its own entry). */
  | { type: 'switch'; oldKind: string; oldName: string; replacedBy: string; scope: Scope }
  | { type: 'pin'; ref: string }
  | { type: 'pickVersion'; repo: string }
  | { type: 'openDetails'; repo: string; mode: 'preview' | 'permanent' }
  | { type: 'copyRepoPath'; repo: string }
  | { type: 'copyShareLink'; repo: string }
  | { type: 'initProject' }
  | { type: 'installGrim' }
  /** Banner "Show grim Info" — opens the grim-info modal so the user can see
   *  which binary resolved and why its install state is unknown (offered when
   *  installing a fresh grim would not change the resolution — a PATH/setting
   *  grim, or a non-too-old failure). */
  | { type: 'showGrimInfo' };

export type HostToSidebar =
  | { type: 'state'; state: SidebarState }
  /** A mutating grim run started (title) or the last one settled (null) —
   *  ANYWHERE in the extension, not just from this view. Every action control
   *  goes inert meanwhile: grim serializes on its own lock, so a second install
   *  fired mid-run stalls behind the first and reads as a dead button. Kept off
   *  {@link SidebarState} so it survives the refresh posts an action ends in. */
  | { type: 'busy'; busy: string | null }
  | { type: 'focusSearch' }
  /** Switches the internal tab bar from the host — the Updates row in the
   *  activity-bar tree view clicks through to the Updates tab. */
  | { type: 'setTab'; tab: SidebarState['mode'] }
  /** A view control fired from the view's TITLE BAR (or the command palette).
   *  The host is a dumb router here: view state stays webview-side, where the
   *  active tab lives — grouping flips a different key per tab, and the host
   *  does not know which tab is showing. */
  | { type: 'viewAction'; action: ViewAction }
  /** The stored view preference, replayed into a freshly-booted webview. The
   *  webview's own setState is workspace-scoped and dies with the view, so this
   *  is what makes density/tree/grouping survive reopening VS Code — and
   *  survive it in a different window. Absent when nothing was ever stored. */
  | { type: 'viewPrefs'; view: ViewOptions };

/** The title-bar view controls, named after what they do. */
export type ViewAction =
  | 'toggle-density'
  | 'toggle-mode'
  | 'toggle-grouping'
  | 'expand-all'
  | 'collapse-all';

export type Density = 'comfortable' | 'compact';
export type ViewMode = 'list' | 'tree';
/** Grouping key for the flat list — one axis per tab, so the control is a
 *  two-state toggle like the others. There is deliberately no group-by-kind:
 *  the Kind chips already slice by kind, and a second control for the same
 *  dimension is one control too many. 'scope' is Installed-only: it replaced
 *  that view's Project/Global toggle, and a card installed in both scopes lands
 *  in BOTH groups (which is the point — one list, both scopes). */
export type GroupKey = 'none' | 'registry' | 'scope';

/** The view preference: how the list is drawn, independent of what is in it.
 *  On the wire because the HOST persists it (globalState) — the webview's own
 *  setState is workspace-scoped and per-view, so it cannot carry a preference
 *  from one window to the next. */
export interface ViewOptions {
  density: Density;
  mode: ViewMode;
  /** Browse's grouping key ('scope' is not offered there — browse cards are
   *  catalog rows, most of which are installed nowhere). */
  browseGroup: GroupKey;
  /** Installed's grouping key. */
  installedGroup: GroupKey;
}

/** What the title bar needs to pick each toggle's icon: the webview owns the
 *  state, so it reports the booleans the `when` clauses key on. */
export interface ViewFlags {
  compact: boolean;
  tree: boolean;
  grouped: boolean;
  /** Whether the ACTIVE tab has a structure to shape at all. Updates is a short
   *  single-purpose list that never trees or groups, so its title bar drops
   *  those controls rather than offering toggles that visibly do nothing. */
  structured: boolean;
  /** Any group/tree node currently open. Drives the ONE expand/collapse-all
   *  button: with something open it offers Collapse All, otherwise Expand All —
   *  so the tree keeps the same number of title-bar icons as the list and
   *  nothing shifts when the mode flips. */
  anyExpanded: boolean;
}

export interface BundleMemberVM {
  kind: string;
  name: string;
  id: string;
  version: string | null;
  /** Resolved absolute repo for openDetails, when resolvable. */
  repo: string | null;
  /** Catalog description, when the member is known to the catalog. */
  description: string | null;
}

export interface DetailsVM {
  repo: string;
  ref: string;
  name: string;
  kind: ArtifactKind | null;
  registryHost: string;
  description: string | null;
  latestVersion: string | null;
  state: RowState;
  deprecated: string | null;
  replacedBy: string | null;
  installs: InstallVM[];
  scopes: ScopesVM;
  /** The artifact's own content for the CONTENTS tab: source markdown for
   *  skills/rules/agents (rendered client-side). Null for mcp/bundle, whose
   *  content is JSON in {@link contentJson}. */
  contentMarkdown: string | null;
  /** The artifact's own content as JSON for the CONTENTS tab: the mcp descriptor
   *  or the bundle manifest (pretty-printed, syntax-highlighted at render). */
  contentJson: string | null;
  /** README.md shipped with the package — the DETAILS tab, shown only when
   *  present; when absent there is no DETAILS tab and CONTENTS is first. */
  readmeMarkdown: string | null;
  /** CHANGELOG.md shipped with the package (CHANGELOG tab, omitted when absent). */
  changelogMarkdown: string | null;
  /** Bundle members parsed out of the members document. */
  members: BundleMemberVM[];
  /** Right-rail Package panel. */
  tags: string[] | null;
  published: string | null;
  revision: string | null;
  digest: string | null;
  /** Resources panel. */
  sourceRepository: string | null;
  license: string | null;
  /** Tags panel (keywords). */
  keywords: string[] | null;
  /** data: URI for the artifact logo, when the package ships one. */
  logoUri: string | null;
  busy: string | null;
  error: string | null;
  /** Skeleton view model posted instantly on open before the full grim
   *  fetch/describe resolves. The full structure renders; content-dependent
   *  regions show local progress. */
  loading?: boolean;
  /** Skeleton posted before the install snapshot is known: render the scope
   *  boxes as pending shells (a spinner in each) rather than real install
   *  state. Absent/false once installs are known (cached snapshot or full VM). */
  scopesPending?: boolean;
  /** Scopes whose install state could not be determined (ScopeSnapshot.status
   *  null). PER SCOPE, unlike the whole-panel {@link scopesPending}: one scope
   *  can be unknown while the other reports real installs. Such a row renders
   *  no install affordance and makes no "Not installed" claim — its absence
   *  from {@link installs} means nothing. */
  unknownScopes?: Scope[];
  /** Host-stamped at post time: true while this panel is the reusable preview
   *  slot, so the header shows a Pin ("Keep open") button. Cleared on promote. */
  isPreview?: boolean;
}

export type DetailsToHost =
  | { type: 'ready'; repo: string }
  | { type: 'install'; scope: Scope }
  | { type: 'uninstall'; kind: string; name: string; scope: Scope }
  | { type: 'update'; kind: string; name: string; scope: Scope }
  /** Deprecation-banner "Switch to replacement": install the named successor in
   *  every installed scope, then uninstall the old one. The single button
   *  covers all scopes — the host derives the actual set from its own snapshot
   *  (installsFor), trusting only `replacedBy` (grim-validated), same
   *  host-authoritative posture as `install`. */
  | { type: 'switch'; oldKind: string; oldName: string; replacedBy: string; scope: Scope }
  /** scope preselected by the originating scope row (skips the scope QuickPick). */
  | { type: 'pickVersion'; scope?: Scope }
  | { type: 'openExternal'; url: string }
  | { type: 'openDetails'; repo: string }
  | { type: 'copyRepoPath'; repo: string }
  | { type: 'copyShareLink'; repo: string }
  /** A rail tag click: focus Browse and seed its search with the tag (item 2). */
  | { type: 'searchTag'; tag: string }
  /** Click on the failed revalidate indicator — host shows the stored message. */
  | { type: 'revalidateError' }
  /** Pin button / body double-click: promote the preview tab to permanent. */
  | { type: 'promote' };

/** Background stale-while-revalidate status shown top-right (warm reopens only). */
export type RevalidateState = 'checking' | 'done' | 'failed';

export type HostToDetails =
  | { type: 'artifact'; vm: DetailsVM }
  /** Action in flight (title) or cleared (null). Broadcast to EVERY open panel,
   *  not only the one that acted — the run holds grim's lock for all of them. */
  | { type: 'busy'; action: string | null }
  /** message is set only on 'failed' (the concrete revalidate error). */
  | { type: 'revalidate'; state: RevalidateState; message?: string }
  /** The panel was promoted out of the preview slot — clear the pin. */
  | { type: 'promoted' };

// --- Settings (singleton editor-area panel) ---

/** Grim's presentation type for a config key's value. webview/settings/model.ts's
 *  buildSettingsRow narrows the wire's open `string` (grim.ts's ConfigEntry.type)
 *  down to this closed set; an unrecognized future value degrades to 'unknown'
 *  (a read-only row) rather than throwing — same split as ArtifactKind (closed,
 *  webview) vs SearchItem.kind (open, wire). */
export type SettingsControlType =
  'string' | 'boolean' | 'enum' | 'string-list' | 'string-set' | 'integer';

/** Per-row transient UI state the webview overlays locally around a write —
 *  mirrors details/main.ts's `vm.busy` direct-mutation pattern; not part of
 *  grim's wire contract, never posted by the host inside a row itself. */
export type SettingsRowStatus = 'idle' | 'saving' | 'error' | 'reloaded';

/** VM-side (camelCase) mirror of grim's `ConfigEntry.constraints` /
 *  `ValueConstraints` — advisory, NOT sufficient (grim's own `config set`
 *  predicate is authoritative; a value matching `itemPattern` can still be
 *  rejected there). Present only for a list key whose items carry a shape
 *  rule beyond membership in `SettingsRowVM.values` (e.g. tree separators);
 *  `null` for every scalar key and for `clients`, whose closed set is
 *  already machine-readable via `values`. */
export interface SettingsRowConstraints {
  /** Advisory regex a single list item should match. */
  itemPattern: string;
  /** Required Unicode display width of a single item — the rule
   *  `itemPattern` can't express. */
  itemWidth: number;
}

export interface SettingsRowVM {
  key: string;
  title: string;
  description: string;
  type: SettingsControlType | 'unknown';
  value: string | null;
  default: string | null;
  set: boolean;
  /** enum/string-set option list; null for every other type. */
  values: string[] | null;
  /** value !== default — drives the row's left-border state-bar accent
   *  (design item 3); independent of `set` (the discard-icon condition). */
  modified: boolean;
  /** Precomputed caption under the row: "Default: false" or, for the two
   *  null-default keys (default_registry/clients), a behavioral sentence. */
  hint: string;
  status: SettingsRowStatus;
  /** Set only alongside status === 'error' — the rejected-value inline message. */
  errorMessage?: string;
  /** Item-shape guard for a list-valued row's chip editor (model.ts's
   *  isValidChip) — see {@link SettingsRowConstraints}. */
  constraints: SettingsRowConstraints | null;
}

export interface SettingsGroupVM {
  title: string;
  rows: SettingsRowVM[];
}

/** grim's presentation metadata for the add-registry form's oci/index/
 *  default controls (`config registry fields`) — fetched once per panel
 *  lifetime (SettingsManager.ensureRegistryFields), independent of scope, so
 *  it rides along on every SettingsState post rather than a message of its
 *  own. `[]` means either the fetch hasn't resolved yet or it failed; either
 *  way render.ts's per-key lookup falls back to its own hardcoded label/
 *  tooltip copy — a failed fetch is never surfaced as an error. */
export interface SettingsRegistryFieldVM {
  key: string;
  title: string;
  description: string;
}

export interface SettingsRegistryVM {
  alias: string | null;
  /** 'unknown' only for a malformed row (neither oci nor index set) — grim's
   *  contract guarantees exactly one of the two, but this stays defensive
   *  rather than throw (frozen/additive tolerance, same policy as everywhere
   *  else in the wire contract). */
  type: 'oci' | 'index' | 'unknown';
  locator: string;
  default: boolean;
  /** Browse filters, already normalized to `[]` by buildRegistryRow — the
   *  webview never sees the wire's optionality. Display-only: nothing here
   *  edits them, because grim's only single-key write path (`config set`)
   *  REPLACES the whole list and reports the discarded patterns to its log
   *  rather than the JSON envelope. */
  include: string[];
  exclude: string[];
  /** alias === null: a legacy pre-alias row — read-only (no remove action). */
  legacy: boolean;
}

export type SettingsPhase =
  'loading' | 'ready' | 'error' | 'no-grim' | 'no-folder' | 'project-no-toml' | 'global-no-toml';

export interface SettingsState {
  scope: Scope;
  phase: SettingsPhase;
  /** A workspace folder is open — mirrors ScopesVM.projectOpen (reused as the
   *  source for buildSettingsVM's phase resolution). */
  projectOpen: boolean;
  projectName: string | null;
  /** Active scope's grimoire.toml path, shown as the faint tab-bar label —
   *  null when it doesn't exist yet (project-no-toml/global-no-toml) or isn't
   *  known. */
  configPath: string | null;
  /** grim context's config_path verbatim, regardless of whether the file
   *  exists — used ONLY by the 'global-no-toml' empty state's inline-code
   *  path chip (design: the real path, never hardcoded, since $GRIM_HOME is
   *  overridable — contrast with project's fixed `grimoire.toml`
   *  copy). Null whenever the path itself isn't known (no-folder/no-grim/error). */
  rawConfigPath: string | null;
  /** The scope Browse is actually searching. The two scope choices are
   *  independent — this panel edits whichever tab is open, Browse picks its own
   *  from live project state — and grim never merges scope config, so an edit
   *  made in the other scope has no effect on what Browse shows. Undefined when
   *  no snapshot has been taken yet (nothing is claimed rather than guessed). */
  searchScope?: Scope;
  groups: SettingsGroupVM[];
  registries: SettingsRegistryVM[];
  /** See {@link SettingsRegistryFieldVM} — always present (possibly `[]`),
   *  regardless of phase, so render.ts never needs to special-case its
   *  absence. */
  registryFields: SettingsRegistryFieldVM[];
  /** The resolved grim accepts `registry add --include/--exclude` and the
   *  `registry set` verb — one release shipped both. Gates the add-registry
   *  form's pattern repeaters AND each row's edit button: false hides them, so
   *  the panel never offers a control whose save is guaranteed to fail. Only
   *  meaningful in the 'ready' phase; every other phase omits both. */
  registryEditSupported: boolean;
  /** The version grim reported for this scope, or null when none was resolved.
   *  Display only, and only ever to say what is running next to what is
   *  required — a gate hint that names the needed version but not the present
   *  one leaves the user to go find it. Never compared in the webview: the
   *  version→capability decision is the host's, and arrives as
   *  {@link registryEditSupported}. */
  grimVersion: string | null;
  error?: string;
}

/** Exactly one of `oci`/`index` — duplicated from grim.ts's RegistryLocator so
 *  this shared, dependency-free module stays independent of the host-only
 *  grim.ts at runtime (same convention as webview/model.ts's WireSearchItem). */
export type RegistryLocator = { oci: string } | { index: string };

/** grim's dotted config key for one field of one registry entry.
 *
 *  Lives here for the same reason {@link RegistryFieldState} does: the webview
 *  spells this key when it demotes a default, and grim.ts spells it again when
 *  it builds the argv, so a rename in grim's key grammar would otherwise fix
 *  one caller and silently leave the other. `webview/protocol.ts` is the only
 *  module both a host file and a bundled webview file may import. */
export function registryFieldKey(alias: string, field: 'default' | 'include' | 'exclude'): string {
  return `registry.${alias}.${field}`;
}

/** The three registry fields an edit cannot clear by omission, held both as
 *  the desired state and as the starting point so the host can tell a real
 *  clear from a field that was already empty or already off. The locator is
 *  not here: it is always written, so it travels as its own field.
 *
 *  Declared HERE, in the module both sides already import, because it is the
 *  one shape the webview authors, the wire carries and the host hands to
 *  grim.ts's editRegistrySteps — a second declaration on either side can
 *  drift from the wire without any type error to say so. */
export interface RegistryFieldState {
  include: string[];
  exclude: string[];
  default: boolean;
}

export type SettingsToHost =
  | { type: 'ready'; scope: Scope }
  | { type: 'switchScope'; scope: Scope }
  | { type: 'setValue'; scope: Scope; key: string; value: string }
  | { type: 'unsetValue'; scope: Scope; key: string }
  | {
      type: 'addRegistry';
      scope: Scope;
      alias: string;
      locator: RegistryLocator;
      /** Browse-filter globs, one entry per pattern. The repeated
       *  `--include`/`--exclude` flags are the only CLI path that writes a
       *  multi-pattern list; both are `[]` for an unfiltered registry. */
      include: string[];
      exclude: string[];
      default: boolean;
    }
  | {
      /** Edit an existing entry in place. Carries the COMPLETE desired state
       *  of every editable field, not a delta: the webview seeded its form
       *  from the row it is editing, so it is the side that knows both halves,
       *  and the host stays a translator. An empty `include`/`exclude`
       *  therefore means "clear it", which the one `config registry set` call
       *  spells as `--clear-include`/`--clear-exclude`. Only DEMOTION needs a
       *  second grim run (`config set registry.<alias>.default false`) —
       *  `--default` has no negative form. */
      type: 'editRegistry';
      scope: Scope;
      alias: string;
      locator: RegistryLocator;
      include: string[];
      exclude: string[];
      default: boolean;
      /** The row's state when the form was opened. Sent so the host can leave
       *  out the `--clear-*` flags and the demotion step when they would change
       *  nothing, and only the webview knows what the user started from. */
      previous: RegistryFieldState;
    }
  | { type: 'removeRegistry'; scope: Scope; alias: string }
  | { type: 'useRegistry'; scope: Scope; alias: string }
  | { type: 'initProject' }
  | { type: 'initGlobal' }
  | { type: 'openConfigFile'; scope: Scope }
  | { type: 'openVsCodeSettings' }
  | { type: 'openExternal'; url: string }
  | { type: 'installGrim' };

export type HostToSettings =
  | { type: 'state'; state: SettingsState }
  /** A write was rejected (grim exit 65/64, or the write-queue's lock-retry
   *  gave up): `key` is the config key OR the attempted registry alias — the
   *  one row/form the message belongs to.
   *
   *  A write can be a SEQUENCE of grim runs, applied in order and ABORTED at
   *  the first failure — so every step before the failing one is already on
   *  disk. Only `editRegistry` is ever more than one today (grim.ts's
   *  editRegistrySteps: the single `config registry set`, then the demotion
   *  `config set registry.<alias>.default false` when the entry is losing the
   *  default flag), and a failure of that second step is therefore NOT
   *  "nothing was written" — the locator/filter half already landed. A 'state'
   *  post accompanies such a partial write, so the webview shows the error
   *  against the config that actually exists now rather than the one the form
   *  asked for. A single-step write that fails does leave the scope unchanged. */
  | { type: 'writeError'; scope: Scope; key: string; message: string };
