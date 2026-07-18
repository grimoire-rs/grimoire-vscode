// Pure view-model builders and reducers. No vscode, no DOM — fully
// unit-testable. The extension host builds view models here and posts them
// to the webviews; the webviews filter/render them.
import type {
  ArtifactKind,
  BundleMemberVM,
  CardVM,
  DetailsVM,
  InstallVM,
  RowState,
  Scope,
  ScopesVM,
  SidebarState,
} from './protocol';

// Wire shapes (duplicated minimally to keep this module dependency-free of
// the host-only grim.ts types at runtime; structurally identical).
export interface WireSearchItem {
  kind: string | null;
  repo: string;
  summary: string | null;
  description: string | null;
  version: string | null;
  latest_tag: string | null;
  repository: string | null;
  revision: string | null;
  created: string | null;
  deprecated: string | null;
  replaced_by?: string | null;
  status: string;
}

export interface WireStatusItem {
  kind: string;
  name: string;
  source?: string;
  // null for unlocked artifacts (grim emits `pinned: null`). Never deref raw.
  pinned: string | null;
  state: string;
  outputs: { client: string; path: string }[];
  // grim's `status` surface (always emitted by a current grim; optional here —
  // like `source?` — so fixtures may omit them, and every reader tolerates
  // absence). clients_missing/clients_extra come from local state (plain
  // status); deprecated/replaced_by/update_available are populated only under
  // `--check` and are null otherwise. See computeUpdateAvailable.
  clients_missing?: string[];
  clients_extra?: string[];
  deprecated?: string | null;
  replaced_by?: string | null;
  update_available?: boolean | null;
}

/** Whether a card/install should surface an update. grim's authoritative
 *  `--check` result wins when present: `true` → update badge/button, `false`
 *  → no update even when the local lock reads `stale` (the network check is the
 *  authority; a stale lock is still re-resolved on the Update click via the
 *  offerFullUpdate path). `null`/absent means the check did not run, so it falls
 *  back to the local-state proxy — `outdated` or `stale`. Pure; the single
 *  source shared by the sidebar model and the details host. */
export function computeUpdateAvailable(item: {
  update_available?: boolean | null;
  state: string;
}): boolean {
  return item.update_available ?? (item.state === 'outdated' || item.state === 'stale');
}

export const KINDS: ArtifactKind[] = ['skill', 'rule', 'agent', 'mcp', 'bundle'];

export const KIND_ICONS: Record<ArtifactKind, string> = {
  skill: 'sparkle',
  rule: 'law',
  agent: 'hubot',
  mcp: 'plug',
  bundle: 'package',
};

export function normalizeKind(kind: string | null | undefined): ArtifactKind | null {
  const k = (kind ?? '').toLowerCase();
  return (KINDS as string[]).includes(k) ? (k as ArtifactKind) : null;
}

/** "ghcr.io/grimoire-rs/skills/grim-usage" -> "ghcr.io" */
export function registryHost(repo: string): string {
  return repo.split('/')[0] ?? repo;
}

/** Card meta line: host + first namespace segment,
 *  "ghcr.io/grimoire-rs/skills/x" -> "ghcr.io/grimoire-rs" (design html:227). */
export function registryLabel(repo: string): string {
  const segments = repo.split('/');
  return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : (segments[0] ?? repo);
}

/** Bare host of a registry url ("https://harbor.acme.io/v2" -> "harbor.acme.io"). */
export function registryUrlHost(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] ?? url;
}

/**
 * Hosts the user is authenticated to (grim context registries with
 * `authenticated: true`). Absent on older binaries -> treated as false, so the
 * set is simply empty and no card is marked private.
 */
export function authenticatedHosts(
  registries: { url: string; authenticated?: boolean }[],
): Set<string> {
  return new Set(
    registries.filter((r) => r.authenticated === true).map((r) => registryUrlHost(r.url)),
  );
}

/** True when a card's registry looks private enough to earn the lock glyph:
 *  authenticated AND not the public default registry (ghcr.io by default) —
 *  a stored credential there (many users are docker-logged-in to it) doesn't
 *  make every card private. */
function isPrivateRegistry(
  host: string,
  authed: Set<string>,
  defaultRegistryHost: string | null,
): boolean {
  return authed.has(host) && host !== defaultRegistryHost;
}

/** Last path segment of a repo. */
export function artifactName(repo: string): string {
  const segments = repo.split('/');
  return segments[segments.length - 1] ?? repo;
}

/** Strips tag/digest off a declared reference: "host/r/name:1.0" -> "host/r/name". */
export function refRepo(ref: string): string {
  const noDigest = ref.split('@')[0] ?? ref;
  const lastColon = noDigest.lastIndexOf(':');
  const lastSlash = noDigest.lastIndexOf('/');
  return lastColon > lastSlash ? noDigest.slice(0, lastColon) : noDigest;
}

/** Tag of a declared reference, if any: "host/r/name:1.0" -> "1.0". */
export function refTag(ref: string): string | null {
  const noDigest = ref.split('@')[0] ?? ref;
  const lastColon = noDigest.lastIndexOf(':');
  const lastSlash = noDigest.lastIndexOf('/');
  return lastColon > lastSlash ? noDigest.slice(lastColon + 1) : null;
}

/**
 * Parses a status `source` field into the bundle repos that provide a member:
 * "direct" (or anything non-bundle) -> []; "bundle: a" -> ["a"]; the
 * comma-joined multi-provider form "bundle: a, b" -> ["a", "b"]. Tolerates a
 * missing field (nullable-means-null: treat as direct).
 */
export function parseViaBundles(source: string | null | undefined): string[] {
  const match = source ? /^bundle:\s*(.+)$/i.exec(source.trim()) : null;
  if (!match || match[1] === undefined) {
    return [];
  }
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ScopeStatus {
  scope: Scope;
  status: WireStatusItem[];
  declared: Record<string, string>;
}

/** Index of installs per repo for one scope. */
function installIndex(scope: ScopeStatus): Map<string, InstallVM> {
  const byRepo = new Map<string, InstallVM>();
  for (const item of scope.status) {
    const declaredRef = scope.declared[item.name];
    // pinned is null for unlocked artifacts; with no declared ref either there
    // is no repo to key on, so skip the item rather than deref null.
    const repo = declaredRef ? refRepo(declaredRef) : item.pinned ? refRepo(item.pinned) : null;
    if (repo === null) {
      continue;
    }
    const version = declaredRef ? refTag(declaredRef) : null;
    byRepo.set(repo, {
      scope: scope.scope,
      version,
      updateAvailable: computeUpdateAvailable(item),
      clients: item.outputs.map((o) => o.client),
      state: item.state,
      kind: item.kind,
      name: item.name,
      viaBundles: parseViaBundles(item.source),
      floating: item.pinned === null,
      clientsMissing: item.clients_missing ?? [],
      clientsExtra: item.clients_extra ?? [],
      deprecated: item.deprecated ?? null,
      replacedBy: item.replaced_by ?? null,
    });
  }
  return byRepo;
}

/** True when an install's client set has drifted from the project's
 *  configured target — grim status's `clients_missing`/`clients_extra` array
 *  non-emptiness IS the explicit-clients signal (grim emits both `[]` under
 *  autodetect), so no extra state to gate on; works on a plain refresh, not
 *  just `--check`. */
export function hasClientDrift(
  install: Pick<InstallVM, 'clientsMissing' | 'clientsExtra'>,
): boolean {
  return (install.clientsMissing?.length ?? 0) > 0 || (install.clientsExtra?.length ?? 0) > 0;
}

/** Drift badge tooltip: "Missing: a, b · Extra: c", either half omitted when
 *  empty. Pure string builder for the render layer. */
export function clientDriftTooltip(
  install: Pick<InstallVM, 'clientsMissing' | 'clientsExtra'>,
): string {
  const parts: string[] = [];
  if (install.clientsMissing && install.clientsMissing.length > 0) {
    parts.push(`Missing: ${install.clientsMissing.join(', ')}`);
  }
  if (install.clientsExtra && install.clientsExtra.length > 0) {
    parts.push(`Extra: ${install.clientsExtra.join(', ')}`);
  }
  return parts.join(' · ');
}

/** The install that applies for a card's single installed chip: a project
 *  install shadows a global one inside a workspace (design 2b). */
export function effectiveInstall(installs: InstallVM[]): InstallVM | undefined {
  return installs.find((i) => i.scope === 'project') ?? installs[0];
}

/** Picks the first candidate that names a concrete version rather than the
 *  floating "latest" tag (grim's own pick_highest_version special-cases only
 *  that literal). Falls back to the first non-null candidate — so a header
 *  with nothing concrete still shows "latest" instead of going blank. */
export function concreteVersion(
  ...candidates: Array<string | null | undefined>
): string | null {
  const present = candidates.filter((c): c is string => c !== null && c !== undefined);
  return present.find((c) => c !== 'latest') ?? present[0] ?? null;
}

export function rowState(deprecated: string | null, installs: InstallVM[]): RowState {
  if (deprecated) {
    return 'deprecated';
  }
  if (installs.length === 0) {
    return 'not-installed';
  }
  return installs.some((i) => i.updateAvailable) ? 'outdated' : 'installed';
}

/** Merges search results with per-scope install status into sidebar cards.
 *  `authed` = registry hosts the user is authenticated to (marks cards
 *  private, except the public default registry — see {@link isPrivateRegistry}). */
export function buildCards(
  items: WireSearchItem[],
  scopes: ScopeStatus[],
  authed: Set<string> = new Set(),
  defaultRegistryHost: string | null = null,
): CardVM[] {
  const indexes = scopes.map((s) => installIndex(s));
  const cards: CardVM[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    seen.add(item.repo);
    const installs = indexes
      .map((index) => index.get(item.repo))
      .filter((i): i is InstallVM => i !== undefined);
    const deprecated = item.deprecated ?? null;
    cards.push({
      repo: item.repo,
      name: artifactName(item.repo),
      kind: normalizeKind(item.kind),
      description: item.description ?? item.summary,
      registryHost: registryHost(item.repo),
      latestVersion: item.version ?? item.latest_tag,
      state: rowState(deprecated, installs),
      deprecated,
      replacedBy: item.replaced_by ?? null,
      installs,
      privateRegistry: isPrivateRegistry(registryHost(item.repo), authed, defaultRegistryHost),
    });
  }
  return cards;
}

/** Cards for installed artifacts only (Installed view) — includes artifacts not in the catalog. */
export function buildInstalledCards(
  items: WireSearchItem[],
  scopes: ScopeStatus[],
  authed: Set<string> = new Set(),
  defaultRegistryHost: string | null = null,
): CardVM[] {
  const catalog = new Map(items.map((i) => [i.repo, i]));
  const byRepo = new Map<string, CardVM>();
  for (const scope of scopes) {
    for (const [repo, install] of installIndex(scope)) {
      const existing = byRepo.get(repo);
      if (existing) {
        existing.installs.push(install);
        continue;
      }
      const item = catalog.get(repo);
      byRepo.set(repo, {
        repo,
        name: install.name,
        kind: normalizeKind(item?.kind ?? install.kind),
        description: item?.description ?? item?.summary ?? null,
        registryHost: registryHost(repo),
        latestVersion: item?.version ?? item?.latest_tag ?? null,
        state: 'installed',
        // Catalog item wins when known; otherwise fall back to the status
        // item's own --check-populated fields (e.g. an artifact installed
        // out-of-band that never showed up in the browse catalog snapshot).
        deprecated: item?.deprecated ?? install.deprecated ?? null,
        replacedBy: item?.replaced_by ?? install.replacedBy ?? null,
        installs: [install],
        privateRegistry: isPrivateRegistry(registryHost(repo), authed, defaultRegistryHost),
      });
    }
  }
  const cards = [...byRepo.values()];
  for (const card of cards) {
    card.state = rowState(card.deprecated, card.installs);
  }
  return cards;
}

export interface CardFilter {
  /** Selected kinds; EMPTY MEANS ALL (the "All" chip). */
  kinds: string[];
  showDeprecated: boolean;
  /** Installed view only: which scope's list to show. undefined = the heuristic
   *  default (see {@link resolveInstalledScope}); set by the SCOPE toggle. */
  scope?: Scope;
}

export const DEFAULT_FILTER: CardFilter = {
  kinds: [],
  showDeprecated: true,
};

/** Default install scope: project when a configured workspace is open (installs
 *  there need a grimoire.toml), else global. Pure. */
export function defaultScope(scopes: { projectOpen: boolean; projectConfigured: boolean }): Scope {
  return scopes.projectOpen && scopes.projectConfigured ? 'project' : 'global';
}

/** Which scope the Installed view shows: the toggle choice, but Project needs a
 *  workspace open (unconfigured is fine — the init banner covers it), so it falls
 *  back to Global with none. Unset → the install heuristic. Pure. */
export function resolveInstalledScope(
  selected: Scope | undefined,
  scopes: { projectOpen: boolean; projectConfigured: boolean },
): Scope {
  if (selected === 'project') {
    return scopes.projectOpen ? 'project' : 'global';
  }
  if (selected === 'global') {
    return 'global';
  }
  return defaultScope(scopes);
}

/** Kind multi-select reducer: empty array means All. Clicking 'all' clears the
 *  selection; toggling a kind adds/removes it; deselecting the last kind or
 *  selecting all of them collapses back to [] (All). Unknown kinds toggle like
 *  any other and simply never match a card. */
export function toggleKinds(current: string[], clicked: string): string[] {
  if (clicked === 'all') {
    return [];
  }
  const next = current.includes(clicked)
    ? current.filter((k) => k !== clicked)
    : [...current, clicked];
  return next.length >= KINDS.length ? [] : next;
}

export function filterCards(cards: CardVM[], filter: CardFilter): CardVM[] {
  return cards.filter((card) => {
    if (filter.kinds.length > 0 && !(card.kind !== null && filter.kinds.includes(card.kind))) {
      return false;
    }
    if (!filter.showDeprecated && card.deprecated) {
      return false;
    }
    return true;
  });
}

/** Name-substring filter for the Installed/Updates search box (case-insensitive,
 *  trimmed; empty query is a pass-through). */
export function searchCards(cards: CardVM[], query: string): CardVM[] {
  const q = query.trim().toLowerCase();
  return q ? cards.filter((c) => c.name.toLowerCase().includes(q)) : cards;
}

export type SidebarTab = SidebarState['mode'];

/** Derives the render-time state for one tab from the combined host post: the
 *  host's `items` are the browse cards and `installedItems` the merged
 *  installed set; Updates is its outdated slice. Browse keeps the host-owned
 *  query (it drives catalog.search); Installed swaps in the client-side name
 *  query; Updates has no search box. Pure — the tab bar and every existing
 *  mode-branching renderer run off the result. */
export function viewForTab(
  state: SidebarState,
  tab: SidebarTab,
  installedQuery: string,
): SidebarState {
  if (tab === 'browse') {
    return { ...state, mode: 'browse' };
  }
  return {
    ...state,
    mode: tab,
    items:
      tab === 'updates'
        ? state.installedItems.filter((c) => c.state === 'outdated')
        : state.installedItems,
    query: tab === 'installed' ? installedQuery : '',
  };
}

/** The Installed view's shown cards: kind filter + name query + scope slice.
 *  Single source both the results template (render.ts) and the sidebar badge
 *  count (sidebar/main.ts) read, so the count can never drift from the list. */
export function installedViewCards(state: SidebarState, filter: CardFilter): CardVM[] {
  const scope = resolveInstalledScope(filter.scope, state.scopes);
  return searchCards(filterCards(state.items, filter), state.query).filter((c) =>
    c.installs.some((i) => i.scope === scope),
  );
}

export function registriesOf(cards: CardVM[]): string[] {
  return [...new Set(cards.map((c) => c.registryHost))].sort();
}

// --- Card menus (gear + right-click context menu share one builder) ---

/** Bundle members can't be uninstalled directly — the display name(s) for the
 *  muted "via …" hint. */
export function viaBundleNames(viaBundles: string[]): string {
  return viaBundles.map((r) => artifactName(r)).join(', ');
}

/** Full repo(s) for the disabled-uninstall tooltip. */
export function viaBundleTitle(viaBundles: string[]): string {
  return `Installed via bundle ${viaBundles.join(', ')} — uninstall the bundle to remove it`;
}

export interface MenuItem {
  label: string;
  /** Omitted => disabled row (no action wiring). */
  action?: string;
  data?: Record<string, string>;
  /** Muted sub-line (e.g. "via <bundle>"). */
  hint?: string;
  /** Tooltip for disabled rows. */
  title?: string;
}

export type MenuEntry = MenuItem | 'separator';

/**
 * Single source of truth for both the gear menu and the right-click context
 * menu. The gear menu (`context: false`) only shows on installed cards, so it
 * omits Open Details / Update / Copy share link; the context menu adds them.
 */
export function cardMenuEntries(
  card: CardVM,
  opts: { projectOpen: boolean; context: boolean },
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const scopesInstalled = new Set(card.installs.map((i) => i.scope));
  if (opts.context) {
    entries.push({ label: 'Open Details', action: 'open-details', data: { repo: card.repo } });
  }
  if (opts.projectOpen && !scopesInstalled.has('project')) {
    entries.push({
      label: 'Install in Project',
      action: 'install',
      data: { repo: card.repo, scope: 'project' },
    });
  }
  if (!scopesInstalled.has('global')) {
    entries.push({
      label: 'Install Globally',
      action: 'install',
      data: { repo: card.repo, scope: 'global' },
    });
  }
  entries.push({
    label: 'Install Version',
    action: 'pick-version',
    data: { repo: card.repo },
  });
  // Update is offered by both the gear menu and the context menu whenever an
  // install is outdated, so a stale Project/Global install can be updated in
  // place from its card gear (item 7).
  const target = card.installs.find((i) => i.updateAvailable);
  if (target) {
    entries.push({
      label: 'Update',
      action: 'update',
      data: { kind: target.kind, name: target.name, scope: target.scope },
    });
  }
  for (const install of card.installs) {
    const label = install.scope === 'project' ? 'Project' : 'Global';
    if (install.viaBundles.length > 0) {
      entries.push({
        label: `Uninstall (${label})`,
        title: viaBundleTitle(install.viaBundles),
        hint: `via ${viaBundleNames(install.viaBundles)}`,
      });
    } else {
      entries.push({
        label: `Uninstall (${label})`,
        action: 'uninstall',
        data: { kind: install.kind, name: install.name, scope: install.scope },
      });
    }
  }
  entries.push(
    'separator',
    { label: 'Pin Version', action: 'pin', data: { repo: card.repo } },
    { label: 'Copy repo path', action: 'copy', data: { repo: card.repo } },
  );
  if (opts.context) {
    entries.push({ label: 'Copy share link', action: 'copy-share', data: { repo: card.repo } });
  }
  return entries;
}

/**
 * Per-scope-row gear menu on the details header. Uninstall and version-switching
 * live on the row's split button; Copy repo path lives in the header (redundant
 * per-row). The only entry left is Update, and only for a via-bundle outdated
 * install — whose button is the `Bundle` nav, not `Update`. Every other row's
 * gear is empty and hidden (see scopeGear); the plumbing stays for future entries.
 */
export function scopeRowMenuEntries(install: InstallVM | null): MenuEntry[] {
  if (install?.updateAvailable && install.viaBundles.length > 0) {
    return [
      {
        label: 'Update',
        action: 'update',
        data: { kind: install.kind, name: install.name, scope: install.scope },
      },
    ];
  }
  return [];
}

// --- Shareable deep links (vscode://grimoire-rs.grimoire-vscode/open?repo=…) ---

export const EXTENSION_ID = 'grimoire-rs.grimoire-vscode';

/** Scheme is passed in (vscode.env.uriScheme differs for stable/insiders). */
export function buildShareLink(scheme: string, repo: string): string {
  return `${scheme}://${EXTENSION_ID}/open?repo=${encodeURIComponent(repo)}`;
}

/** Reads the repo out of an /open URI query string; null when absent/empty. */
export function parseShareLink(query: string): string | null {
  const repo = new URLSearchParams(query).get('repo');
  return repo && repo.length > 0 ? repo : null;
}

/** Conservative repo shape: host + at least one path segment, no HTML/space. */
export function isValidRepo(repo: string): boolean {
  return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._:@-]+)+$/.test(repo);
}

/** "synced 12 min ago" style relative time. */
export function relativeTime(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.round(hours / 24)} d ago`;
}

// --- Frontmatter (skills/rules carry YAML frontmatter in their canonical doc)

export interface Frontmatter {
  description: string | null;
  license: string | null;
  summary: string | null;
  keywords: string[] | null;
  repository: string | null;
}

/**
 * Extracts the fields the details page needs from a canonical document's
 * YAML frontmatter. Line-based on purpose — the grim frontmatter schema is
 * flat `key: value` (metadata.* nested one level).
 */
export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const empty: Frontmatter = {
    description: null,
    license: null,
    summary: null,
    keywords: null,
    repository: null,
  };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match || match[1] === undefined) {
    return { frontmatter: empty, body: content };
  }
  const body = content.slice(match[0].length);
  const fm = { ...empty };
  for (const line of match[1].split('\n')) {
    const kv = /^\s*([A-Za-z_-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!kv || kv[1] === undefined || kv[2] === undefined) {
      continue;
    }
    const key = kv[1].toLowerCase();
    const value = kv[2].replace(/^["']|["']$/g, '');
    if (key === 'description' && !fm.description) {
      fm.description = value;
    } else if (key === 'license') {
      fm.license = value;
    } else if (key === 'summary') {
      fm.summary = value;
    } else if (key === 'repository') {
      fm.repository = value;
    } else if (key === 'keywords') {
      fm.keywords = value
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
    }
  }
  return { frontmatter: fm, body };
}

/** Pretty-prints a JSON string for the CONTENTS tab; falls back to the trimmed
 *  raw text when it doesn't parse (grim descriptors are valid JSON, but stay
 *  defensive rather than throw on a malformed fetch). */
export function prettyJson(text: string): string {
  const trimmed = text.trim();
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/** Parses a bundle members document ({"members":[{kind,name,id}]}). */
export function parseBundleMembers(content: string): BundleMemberVM[] {
  try {
    const doc = JSON.parse(content) as {
      members?: { kind?: string; name?: string; id?: string }[];
    };
    if (!Array.isArray(doc.members)) {
      return [];
    }
    return doc.members
      .filter((m) => typeof m.name === 'string')
      .map((m) => ({
        kind: m.kind ?? 'skill',
        name: m.name as string,
        id: m.id ?? '',
        version: m.id ? refTag(m.id) : null,
        repo: null,
        description: null,
      }));
  } catch {
    return [];
  }
}

/**
 * Resolves a bundle member id (deployment-relative or absolute ref) to an
 * absolute repo, against the bundle's own repo.
 */
export function resolveMemberRepo(bundleRepo: string, id: string): string | null {
  const bare = refRepo(id);
  if (bare === '') {
    return null;
  }
  const first = bare.split('/')[0] ?? '';
  if (!bare.startsWith('.') && first.includes('.')) {
    return bare; // already absolute (leading registry host)
  }
  const base = bundleRepo.split('/').slice(0, -1);
  for (const segment of bare.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (base.length <= 1) {
        return null; // walked past the registry host
      }
      base.pop();
    } else {
      base.push(segment);
    }
  }
  return base.length > 1 ? base.join('/') : null;
}

/** Finds a well-known asset path in a fetch files[] listing (e.g. logo). */
export function findAssetPath(
  files: { path: string }[] | undefined,
  names: string[],
): string | null {
  for (const file of files ?? []) {
    const base = file.path.split('/').pop()?.toLowerCase() ?? '';
    if (names.includes(base)) {
      return file.path;
    }
  }
  return null;
}

const ASSET_MIME: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Structural view of a grim `DescFile` (grim.ts); duplicated so this pure
 *  module stays free of host imports. */
interface DescAsset {
  path: string;
  size?: number;
  content?: string;
  encoding?: string;
}

/** data: URI for one companion asset, or null when it isn't an inlineable image
 *  or ships no content (omit-empty). base64 members pass through; a utf8 SVG is
 *  base64-encoded like fetchLogo. */
function descAssetDataUri(file: DescAsset): string | null {
  const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
  const mime = ASSET_MIME[ext];
  if (!mime || file.content === undefined) {
    return null;
  }
  if (file.encoding === 'base64') {
    return `data:${mime};base64,${file.content}`;
  }
  if (ext === 'svg') {
    return `data:${mime};base64,${Buffer.from(file.content, 'utf8').toString('base64')}`;
  }
  return null; // utf8 body for a raster image is meaningless — leave it be
}

/**
 * Rewrites a v2 companion README's markdown image refs (`![alt](path)`) to inline
 * data: URIs when the path resolves to a companion file; a leading `./` is
 * stripped before matching. Unknown paths are left untouched.
 *
 * ponytail: markdown image syntax is the ONLY image channel — the details webview
 * renders with markdown-it `html:false`, so raw <img> can't appear and a regex
 * over `![](…)` covers every rendered image. The base64 body is [A-Za-z0-9+/=]
 * only, so hostile companion content can't break out of the `(…)` — no HTML parse
 * needed.
 */
export function resolveCompanionAssets(markdown: string, files: DescAsset[]): string {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt: string, ref: string) => {
    const file = byPath.get(ref.replace(/^\.\//, '')) ?? byPath.get(ref);
    if (!file) {
      return whole;
    }
    const uri = descAssetDataUri(file);
    return uri ? `![${alt}](${uri})` : whole;
  });
}

export interface DetailsSources {
  repo: string;
  searchItem: WireSearchItem | null;
  describe: {
    ref: string;
    digest: string;
    kind: string | null;
    name: string;
    title: string | null;
    description: string | null;
    summary: string | null;
    version: string | null;
    license: string | null;
    repository: string | null;
    revision: string | null;
    created: string | null;
    keywords: string[] | null;
    deprecated: string | null;
    replaced_by: string | null;
    tags: string[];
  } | null;
  fetch: {
    ref: string;
    digest: string;
    kind: string | null;
    name: string;
    content: string;
    files?: { path: string; size: number }[];
  } | null;
  installs: InstallVM[];
  scopes: ScopesVM;
  logoUri: string | null;
  /** README.md / CHANGELOG.md contents when the package ships them. */
  readme?: string | null;
  changelog?: string | null;
  /** Full catalog — used to enrich bundle members with repo + description. */
  catalog?: WireSearchItem[];
}

/**
 * Instant skeleton view model posted the moment a details panel opens, built
 * from data already at hand (the catalog search item) so the header shows
 * without waiting on grim. `loading: true` swaps the body for a spinner; the
 * full VM from {@link buildDetailsVM} replaces it. Falls back to a
 * repo-derived name / unknown kind for deep links not in the catalog.
 */
export function buildSkeletonVM(
  repo: string,
  searchItem: WireSearchItem | null,
  scopes: ScopesVM,
  /** Real per-scope installs when a snapshot is already cached (item 2); omit to
   *  render the scope boxes as pending shells until the full VM lands. */
  installs?: InstallVM[],
): DetailsVM {
  const deprecated = searchItem?.deprecated ?? null;
  return {
    repo,
    ref: repo,
    name: artifactName(repo),
    kind: normalizeKind(searchItem?.kind ?? null),
    registryHost: registryHost(repo),
    description: searchItem?.description ?? searchItem?.summary ?? null,
    latestVersion: searchItem?.version ?? searchItem?.latest_tag ?? null,
    state: rowState(deprecated, installs ?? []),
    deprecated,
    replacedBy: searchItem?.replaced_by ?? null,
    installs: installs ?? [],
    scopes,
    contentMarkdown: null,
    contentJson: null,
    readmeMarkdown: null,
    changelogMarkdown: null,
    members: [],
    tags: null,
    published: null,
    revision: null,
    digest: null,
    sourceRepository: null,
    license: null,
    keywords: null,
    logoUri: null,
    busy: null,
    error: null,
    loading: true,
    scopesPending: installs === undefined,
  };
}

/** True when an incoming details VM targets a different artifact than the one
 *  currently rendered, so the webview must reset per-panel UI state (scroll
 *  position, revalidate indicator) that survives a wholesale root re-render. A
 *  null prev means nothing has rendered yet — the first paint never "resets". */
export function shouldResetUi(prevRepo: string | null, nextRepo: string): boolean {
  return prevRepo !== null && prevRepo !== nextRepo;
}

/** True when an incoming loading state should NOT replace already-painted
 *  results: a refresh (reload button, file watcher) over a ready/error paint
 *  keeps the current cards visible and swaps only the footer to the
 *  "Refreshing…" line — no skeleton flash. The initial load (no prior paint)
 *  and the no-grim screen still render the loading state in full. */
export function keepPaintedOnLoading(
  prev: Pick<SidebarState, 'phase'> | null,
  next: Pick<SidebarState, 'phase'>,
): boolean {
  return next.phase === 'loading' && (prev?.phase === 'ready' || prev?.phase === 'error');
}

/** Whether the periodic footer-aging tick may repaint the footer: only with a
 *  painted state and never while a refresh is in flight — a tick during a
 *  kept-painted reload would stomp the pending or shown "Refreshing…" line
 *  with a stale ready footer. */
export function footerTickRenders(
  state: SidebarState | null,
  refreshInFlight: boolean,
): state is SidebarState {
  return state !== null && !refreshInFlight;
}

/** Controls a body double-click ignores (it must not promote when the click
 *  landed on a button, link, tab, or any data-action element). */
export const INTERACTIVE_SELECTOR = '[data-action], a, button, .tab';

/** True when a double-click target sits on (or inside) an interactive control,
 *  so the body-dblclick promote should be suppressed. Structurally typed on
 *  `closest` — the DOM does the ancestor walk; this stays unit-testable with a
 *  fake element and no DOM lib. */
export function isInteractiveTarget(
  el: { closest(selector: string): unknown } | null,
): boolean {
  return el != null && el.closest(INTERACTIVE_SELECTOR) != null;
}

/** Merges describe/search/fetch sources into the details view model. */
export function buildDetailsVM(sources: DetailsSources): DetailsVM {
  const { repo, searchItem, describe, fetch, installs, scopes } = sources;
  const kind = normalizeKind(describe?.kind ?? fetch?.kind ?? searchItem?.kind ?? null);
  let contentMarkdown: string | null = null;
  let contentJson: string | null = null;
  let frontmatter: Frontmatter | null = null;
  let members: BundleMemberVM[] = [];
  if (fetch) {
    if (kind === 'bundle') {
      members = parseBundleMembers(fetch.content);
      const catalog = sources.catalog ?? [];
      for (const member of members) {
        const resolved = resolveMemberRepo(repo, member.id);
        const item =
          catalog.find((i) => i.repo === resolved) ??
          catalog.find(
            (i) => artifactName(i.repo) === member.name && normalizeKind(i.kind) === member.kind,
          ) ??
          null;
        member.repo = item?.repo ?? resolved;
        member.description = item?.description ?? item?.summary ?? null;
      }
      // The raw manifest sits under the member boxes in the CONTENTS tab.
      contentJson = prettyJson(fetch.content);
    } else {
      const parsed = parseFrontmatter(fetch.content);
      frontmatter = parsed.frontmatter;
      if (kind === 'mcp' && parsed.body.trimStart().startsWith('{')) {
        // MCP descriptors are JSON — highlighted directly in CONTENTS, not fenced.
        contentJson = prettyJson(parsed.body);
      } else {
        contentMarkdown = parsed.body;
      }
    }
  }
  const deprecated = describe?.deprecated ?? searchItem?.deprecated ?? null;
  return {
    repo,
    ref: describe?.ref ?? fetch?.ref ?? repo,
    name: describe?.name ?? fetch?.name ?? artifactName(repo),
    kind,
    registryHost: registryHost(repo),
    description:
      describe?.description ??
      searchItem?.description ??
      frontmatter?.description ??
      searchItem?.summary ??
      null,
    latestVersion: describe?.version ?? searchItem?.version ?? searchItem?.latest_tag ?? null,
    state: rowState(deprecated, installs),
    deprecated,
    replacedBy: describe?.replaced_by ?? searchItem?.replaced_by ?? null,
    installs,
    scopes,
    contentMarkdown,
    contentJson,
    readmeMarkdown: sources.readme ?? null,
    changelogMarkdown: sources.changelog ?? null,
    members,
    tags: describe ? describe.tags : null,
    published: describe?.created ?? searchItem?.created ?? null,
    revision: describe?.revision ?? searchItem?.revision ?? null,
    digest: describe?.digest ?? fetch?.digest ?? null,
    sourceRepository:
      describe?.repository ?? searchItem?.repository ?? frontmatter?.repository ?? null,
    license: describe?.license ?? frontmatter?.license ?? null,
    keywords: describe?.keywords ?? frontmatter?.keywords ?? null,
    logoUri: sources.logoUri,
    busy: null,
    error: null,
  };
}
