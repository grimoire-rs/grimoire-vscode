// Message protocol between the extension host and the webviews. Shared,
// dependency-free (no vscode / DOM imports) so both sides and the tests can
// import it.

export type Scope = 'project' | 'global';

export type ArtifactKind = 'skill' | 'rule' | 'agent' | 'mcp' | 'bundle';

export type RowState = 'not-installed' | 'installed' | 'outdated' | 'deprecated';

export interface InstallVM {
  scope: Scope;
  /** Declared version/tag shown on the chip (e.g. "1.4.2", "latest"). */
  version: string | null;
  /** True when grim reports the install as outdated/stale. */
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
  /** True when the card's registry host is one the user is authenticated to
   *  (a private registry) — renders a lock glyph. Absent/false = public. */
  privateRegistry?: boolean;
  /** data: URI of the artifact logo when the details cache has one (prefetched
   *  or previously opened); shown in place of the codicon tile. */
  logoUri?: string | null;
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
   *  tab is its `state === 'outdated'` slice; the Installed tab applies the
   *  SCOPE toggle client-side. Rides every post so tab switches never need a
   *  host round-trip. */
  installedItems: CardVM[];
  scopes: ScopesVM;
  registries: string[];
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
}

export type SidebarToHost =
  | { type: 'ready' }
  | { type: 'search'; query: string }
  | { type: 'refresh' }
  | { type: 'install'; ref: string; scope: Scope }
  | { type: 'uninstall'; kind: string; name: string; scope: Scope }
  | { type: 'update'; kind: string; name: string; scope: Scope }
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
  | { type: 'installGrim' };

export type HostToSidebar = { type: 'state'; state: SidebarState } | { type: 'focusSearch' };

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
  | { type: 'busy'; action: string }
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
  | 'string'
  | 'boolean'
  | 'enum'
  | 'string-list'
  | 'string-set'
  | 'integer';

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
  /** alias === null: a legacy pre-alias row — read-only (no remove action). */
  legacy: boolean;
}

export type SettingsPhase =
  | 'loading'
  | 'ready'
  | 'error'
  | 'no-grim'
  | 'no-folder'
  | 'project-no-toml'
  | 'global-no-toml';

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
  groups: SettingsGroupVM[];
  registries: SettingsRegistryVM[];
  /** See {@link SettingsRegistryFieldVM} — always present (possibly `[]`),
   *  regardless of phase, so render.ts never needs to special-case its
   *  absence. */
  registryFields: SettingsRegistryFieldVM[];
  error?: string;
}

/** Exactly one of `oci`/`index` — duplicated from grim.ts's RegistryLocator so
 *  this shared, dependency-free module stays independent of the host-only
 *  grim.ts at runtime (same convention as webview/model.ts's WireSearchItem). */
export type RegistryLocator = { oci: string } | { index: string };

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
      default: boolean;
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
   *  one row/form the message belongs to. The state itself is unchanged
   *  (nothing was written), so no accompanying 'state' post follows. */
  | { type: 'writeError'; scope: Scope; key: string; message: string };
