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
}

export type SidebarToHost =
  | { type: 'ready' }
  | { type: 'search'; query: string }
  | { type: 'refresh' }
  | { type: 'install'; ref: string; scope: Scope }
  | { type: 'uninstall'; kind: string; name: string; scope: Scope }
  | { type: 'update'; kind: string; name: string; scope: Scope }
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
