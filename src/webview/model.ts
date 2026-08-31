// Pure view-model builders and reducers. No vscode, no DOM — fully
// unit-testable. The extension host builds view models here and posts them
// to the webviews; the webviews filter/render them.
import type {
  ArtifactKind,
  BundleMemberVM,
  CardSource,
  CardVM,
  DetailsVM,
  InstallVM,
  GroupKey,
  RatingVM,
  RegistryVM,
  RowState,
  Scope,
  ScopesVM,
  SidebarState,
  SupportVM,
  ViewOptions,
  VoteState,
} from './protocol';

// Wire shapes (duplicated minimally to keep this module dependency-free of
// the host-only grim.ts types at runtime; structurally identical).
export interface WireSearchItem {
  kind: string | null;
  repo: string;
  /** grim's per-row registry attribution. Optional here for the same reason it
   *  is optional in grim.ts: a grim without it simply omits the key. */
  source?: { alias: string | null; locator: string } | null;
  summary: string | null;
  description: string | null;
  version: string | null;
  latest_tag: string | null;
  repository: string | null;
  revision: string | null;
  created: string | null;
  deprecated: string | null;
  replaced_by?: string | null;
  /** grim's per-row rating. Optional for the same reason `source` is: a grim
   *  without the field omits the key, and grim's own "unrated" is a null. */
  rating?: { up: number; url: string } | null;
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
  /** Outputs an install would write that the install record does not already
   *  account for — materialization drift. Never moves `state`. */
  outputs_pending?: { client: string; path: string }[];
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
 *  → no update even when the local lock reads `outdated` (the network check is
 *  the authority). `null`/absent means the check did not run, so it falls back
 *  to the ONE local-state proxy that means "a newer artifact is waiting":
 *  `outdated` — grim derives it from the lock pin vs the install-state record,
 *  so an install really would change bits.
 *
 *  `stale` is NOT that. grim derives it from the live config vs the lock's
 *  declaration hash: editing grimoire.toml (adding a registry, renaming an
 *  alias) marks EVERY declared artifact stale at once, and counting it as an
 *  update lit an Update button on all of them — a whole global config reading as
 *  "12 updates available" the moment one line changed. Its remedy is `grim
 *  lock`, not `grim update`; the Update click still recovers a stale lock
 *  through the offerFullUpdate path when the row genuinely has an update.
 *
 *  Pure; the single source shared by the sidebar model and the details host. */
export function computeUpdateAvailable(item: {
  update_available?: boolean | null;
  state: string;
}): boolean {
  return item.update_available ?? item.state === 'outdated';
}

export const KINDS: ArtifactKind[] = ['skill', 'rule', 'agent', 'mcp', 'bundle'];

/** Codicon per artifact kind. `agent` and `mcp` use the icons the codicon set
 *  added for exactly those concepts; the design mockups predate them and asked
 *  for hubot/plug as the closest stand-ins. */
export const KIND_ICONS: Record<ArtifactKind, string> = {
  skill: 'sparkle',
  rule: 'law',
  agent: 'agent',
  mcp: 'mcp',
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

/** Key into a scope's declared-ref map. grim identifies an artifact by
 *  (kind, name) — grimoire.toml is five tables of `name = "ref"`, so ONE name
 *  can be declared as both a skill and an agent, and `grim status` reports both
 *  rows. Keyed by name alone, the two rows read the same ref: the skill got the
 *  agent's repo, the two collapsed into one card, and the update count dropped
 *  the loser. `kind` is grim's own lowercase kind string (the `[skills]` table
 *  declares kind `skill`); lowercased here so a hand-written table heading
 *  cannot miss its rows. Pure; shared by the parser (scopes.ts) and both
 *  readers (installIndex here, installState in views/details.ts) so the key is
 *  built in exactly one way. */
export function declaredKey(kind: string, name: string): string {
  return `${kind.toLowerCase()}:${name}`;
}

export interface ScopeStatus {
  scope: Scope;
  /** Null when the scope's install state is unknown (see ScopeSnapshot.status);
   *  never coerce to `[]` — that is the positive "nothing installed" claim. */
  status: WireStatusItem[] | null;
  /** Why `status` is null. Carried on the render-facing status so the ONE
   *  producer (`scopeStatuses`) speaks for every "unknown" — a real scope's
   *  `statusUnknownReason` OR a synthesized `'probe-failed'` for a scope whose
   *  `grim context` probe failed and so never produced a ScopeSnapshot. Absent
   *  exactly when `status !== null`. */
  unknownReason?: 'too-old' | 'status-failed' | 'probe-failed';
  /** The scope's grimoire.toml refs, keyed by {@link declaredKey} — NOT by
   *  name: one name may be declared in two artifact tables. */
  declared: Record<string, string>;
}

/** Installs per repo for one scope, MANY per repo: two declarations can point
 *  at one repo (a second `grim add … --name other`, or a repo published as two
 *  kinds), and they are distinct artifacts with their own state and update
 *  verdict. Keeping only the last dropped one out of the Installed list and out
 *  of the update count. Empty when the scope's install state is unknown — the
 *  single funnel both buildCards and buildInstalledCards go through, so one
 *  guard here covers every card surface. */
function installIndex(scope: ScopeStatus): Map<string, InstallVM[]> {
  const byRepo = new Map<string, InstallVM[]>();
  if (scope.status === null) {
    // Nothing to index — and nothing here may imply "not installed". The card
    // surfaces make that distinction one level up, off SidebarState's
    // installStateUnknown: it suppresses every install/update affordance and
    // turns the Updates pill into "?" rather than a count of an empty list.
    return byRepo;
  }
  for (const item of scope.status) {
    const declaredRef = scope.declared[declaredKey(item.kind, item.name)];
    // pinned is null for unlocked artifacts; with no declared ref either there
    // is no repo to key on, so skip the item rather than deref null.
    const repo = declaredRef ? refRepo(declaredRef) : item.pinned ? refRepo(item.pinned) : null;
    if (repo === null) {
      continue;
    }
    const version = declaredRef ? refTag(declaredRef) : null;
    const installs = byRepo.get(repo) ?? [];
    installs.push({
      scope: scope.scope,
      version,
      updateAvailable: computeUpdateAvailable(item),
      clients: (item.outputs ?? []).map((o) => o.client),
      state: item.state,
      kind: item.kind,
      name: item.name,
      viaBundles: parseViaBundles(item.source),
      floating: item.pinned === null,
      clientsMissing: item.clients_missing ?? [],
      clientsExtra: item.clients_extra ?? [],
      outputsPending: item.outputs_pending ?? [],
      deprecated: item.deprecated ?? null,
      replacedBy: item.replaced_by ?? null,
    });
    byRepo.set(repo, installs);
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

/** True when an install would still write something for this artifact — grim
 *  status's `outputs_pending`. Deliberately NOT drift or damage: the artifact is
 *  installed and intact at its locked pin, there is simply an output (usually a
 *  client that gained support since the last install) not yet materialized.
 *  `grim install` clears it. */
export function hasOutputsPending(install: Pick<InstallVM, 'outputsPending'>): boolean {
  return (install.outputsPending?.length ?? 0) > 0;
}

/** Pending-outputs tooltip: one "client → path" per line, so the hint names
 *  exactly what an install would write. Pure string builder for the render
 *  layer. */
export function outputsPendingTooltip(install: Pick<InstallVM, 'outputsPending'>): string {
  const pending = install.outputsPending ?? [];
  return ['An install would also write:', ...pending.map((o) => `${o.client} → ${o.path}`)].join(
    '\n',
  );
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

/** Decorations a cached details snapshot lends a card (host-side detailsCache).
 *  Structural, so this pure module needs no import from the extension host. */
export interface CardMeta {
  logoUri: string | null;
  version: string | null;
}

/** Folds cached logo/version decorations into cards, IN PLACE.
 *
 *  The version half is what gives index-backed rows a version at all: an index
 *  is a phone book, so `grim search` reports null `version`/`latest_tag` for
 *  every repo behind one and only a live `grim describe` knows the tag. A
 *  catalog-supplied version always wins — it is this round's answer, where the
 *  cache is a snapshot of an older one. */
export function applyCardMeta(cards: CardVM[], meta: Map<string, CardMeta>): void {
  for (const card of cards) {
    const cached = meta.get(card.repo);
    if (!cached) {
      continue;
    }
    if (cached.logoUri) {
      card.logoUri = cached.logoUri;
    }
    if (card.latestVersion === null && cached.version) {
      card.latestVersion = cached.version;
    }
  }
}

/** The repo an installed artifact belongs to, found by its install identity —
 *  the identity every mutating message carries (kind + name + scope), where the
 *  cache is keyed by repo. Null when no loaded card claims it. Pure. */
export function repoForInstall(
  cards: CardVM[],
  kind: string,
  name: string,
  scope: Scope,
): string | null {
  const hit = cards.find((c) =>
    c.installs.some((i) => i.kind === kind && i.name === name && i.scope === scope),
  );
  return hit?.repo ?? null;
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
export function concreteVersion(...candidates: Array<string | null | undefined>): string | null {
  const present = candidates.filter((c): c is string => c !== null && c !== undefined);
  return present.find((c) => c !== 'latest') ?? present[0] ?? null;
}

/** The version a browse card/row shows: what IS installed here when it is
 *  installed, else the catalog's latest. Switching an artifact to another
 *  version is a change to the declared ref, so this is the value that has to
 *  move when the user does that — binding the chip to `latestVersion` alone left
 *  the row reading the same number after a downgrade or a pin.
 *
 *  Same expression as the details header ({@link concreteVersion} over the same
 *  two candidates), so the row and the panel it opens cannot disagree: a
 *  floating "latest" declaration falls through to the resolved catalog version
 *  rather than rendering the word "latest". */
export function cardVersion(card: Pick<CardVM, 'installs' | 'latestVersion'>): string | null {
  return concreteVersion(effectiveInstall(card.installs)?.version, card.latestVersion);
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

/** The single "this card has an update" predicate — NOT `state === 'outdated'`.
 *  rowState above shadows outdated with 'deprecated', and `deprecated` is
 *  itself a `--check`-only field, so counting by row state dropped a
 *  deprecated-but-updatable artifact out of the count on exactly the rounds
 *  that had network-verified data. A deprecated artifact with a newer version is
 *  still an update — its card demotes the action rather than dropping it: the
 *  1g state matrix gives a deprecated row the installed chip and gear menu, and
 *  the Update entry lives in that menu (cardMenuEntries offers it off the same
 *  `updateAvailable` an install carries).
 *
 *  The one predicate behind every update number: {@link updateCount} (the
 *  activity-bar badge, from the sidebar's refresh AND from activation's
 *  badge-only round), the UPDATES tab pill (render.ts) and the Updates tab's own
 *  slice (viewForTab) all read it, so the number on the icon, the number on the
 *  pill and the length of the rendered list are one computation and cannot
 *  disagree. */
export function hasUpdate(card: Pick<CardVM, 'installs'>): boolean {
  return card.installs.some((i) => i.updateAvailable);
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
  // One card per repository. `grim search` flattens its per-source groups, so
  // the SAME repo arrives twice whenever two configured sources list it — an
  // index and the registry it indexes, most obviously. The cards render through
  // a `repeat()` keyed on `repo`, and lit-html requires those keys to be
  // unique, so a duplicate is a rendering fault, not a cosmetic one. First
  // occurrence wins: groups arrive in registry declaration order, so the card
  // comes from the source that would resolve the reference.
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.repo)) {
      continue;
    }
    seen.add(item.repo);
    const installs = indexes.flatMap((index) => index.get(item.repo) ?? []);
    const deprecated = item.deprecated ?? null;
    const source = readSource(item.source);
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
      ...(source ? { source } : {}),
      privateRegistry: isPrivateRegistry(registryHost(item.repo), authed, defaultRegistryHost),
      rating: readRating(item.rating),
      updated: item.created,
    });
  }
  return cards;
}

/**
 * A wire rating, read defensively into a {@link RatingVM}. Null for every shape
 * that is not a complete rating — absent key (older grim), explicit null
 * (grim's "unrated"), a non-finite or negative count, an empty url. Unrated is
 * a first-class outcome at each of those levels and never an error.
 *
 * `vote` starts at `'unknown'` and can start nowhere else: `grim search`
 * carries no identity, so the aggregate count says nothing whatsoever about
 * whether THIS viewer voted (C-008 rule 4: the aggregate may never overwrite
 * the viewer's own record).
 */
/** Anything carrying an explicit URI scheme. Deliberately broad: this only
 *  decides whether a value is a URL at all — {@link isOpenableUrl} is the gate
 *  that decides which schemes the host will actually open. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** An address shape strict enough to wrap in `mailto:` without inventing one
 *  for arbitrary text: no whitespace, exactly one `@`, a dotted right side, and
 *  none of the characters that turn a `mailto:` into more than an address —
 *  `?` opens the header list (`?bcc=`, `?body=`), `#` a fragment, `%` percent
 *  encoding that can smuggle a newline into a header. A real address carries
 *  none of them, so excluding them costs nothing and closes the injection. */
const EMAIL = /^[^\s@?#%&]+@[^\s@?#%&]+\.[^\s@?#%&]+$/;

/**
 * `support.contact` may be a bare email address rather than a URL — grim
 * publishes whatever the maintainer authored. Only two shapes become a link:
 * one that already carries a scheme, used verbatim, and one that looks like an
 * address, wrapped in `mailto:`. Anything else returns null and renders as
 * plain text; a scheme is never invented for an arbitrary string.
 */
export function contactUrl(contact: string): string | null {
  const value = contact.trim();
  if (HAS_SCHEME.test(value)) {
    return value;
  }
  return EMAIL.test(value) ? `mailto:${value}` : null;
}

/**
 * The host's allowlist for the webview's `open` action. Web links plus the one
 * scheme the SUPPORT panel needs — and `mailto:` only for a value that is
 * actually an address, so a webview posting `mailto:` + arbitrary text (header
 * injection into a prefilled draft, say) is refused at the host boundary rather
 * than trusted because {@link contactUrl} was supposed to have checked it.
 */
export function isOpenableUrl(url: string): boolean {
  return /^https?:/.test(url) || (url.startsWith('mailto:') && EMAIL.test(url.slice(7)));
}

/** grim's `describe.support` on the wire. Mirrored here rather than imported
 *  so this module stays free of grim.ts, same as {@link WireSearchItem}. */
export interface WireSupport {
  issues: string | null;
  chat: string | null;
  contact: string | null;
  security: string | null;
}

/** Normalizes grim's `describe.support` for the VM. A grim predating the
 *  surface omits the object outright and a current one nulls the channels the
 *  publisher left unset, so both collapse to the same four nulls — which is
 *  exactly what omits the SUPPORT panel. */
export function readSupport(raw: WireSupport | undefined): SupportVM {
  return {
    issues: raw?.issues ?? null,
    chat: raw?.chat ?? null,
    contact: raw?.contact ?? null,
    security: raw?.security ?? null,
  };
}

export function readRating(raw: WireSearchItem['rating']): RatingVM | null {
  if (!raw || typeof raw.url !== 'string' || raw.url === '') {
    return null;
  }
  if (typeof raw.up !== 'number' || !Number.isFinite(raw.up) || raw.up < 0) {
    return null;
  }
  return { up: raw.up, url: raw.url, vote: 'unknown' };
}

/**
 * The viewer's vote state after a `grim rate` call, per S-007: the mutation
 * response is authoritative and no second query is issued.
 *
 * `report` is null when the call FAILED — and a failure resolves to
 * `'unknown'`, never `'not-voted'`. A vote that times out may well have landed
 * on the forge; claiming "you have not voted" would be a guess dressed as a
 * fact, and would invite a second vote that silently toggles the first back
 * off. Unknown is the honest answer and the safe one.
 *
 * `action` is grim's open string, echoed from the request it just carried out.
 * Anything this does not recognise reads as unknown rather than as a default.
 */
export function voteStateAfter(report: { action: string } | null): VoteState {
  if (report === null) {
    return 'unknown';
  }
  if (report.action === 'up' || report.action === 'added') {
    return 'voted';
  }
  if (report.action === 'remove' || report.action === 'removed') {
    return 'not-voted';
  }
  return 'unknown';
}

/** grim's per-row attribution, read defensively: the key is absent on an older
 *  grim, and a malformed one is worth nothing — an unattributed card falls back
 *  to longest-configured-prefix, which is grim's own rule for the same case. */
function readSource(raw: WireSearchItem['source']): CardSource | undefined {
  if (!raw || typeof raw.locator !== 'string' || raw.locator === '') {
    return undefined;
  }
  return { alias: typeof raw.alias === 'string' && raw.alias !== '' ? raw.alias : null, locator: raw.locator };
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
    for (const [repo, installs] of installIndex(scope)) {
      const existing = byRepo.get(repo);
      if (existing) {
        existing.installs.push(...installs);
        continue;
      }
      // Every install here shares the repo, so any of them names the card; the
      // first is the one the card's header shows. (installIndex never stores an
      // empty array — the guard is for the type, not a reachable state.)
      const install = installs[0];
      if (!install) {
        continue;
      }
      const item = catalog.get(repo);
      // `grim status` carries no registry attribution (its own `source` field
      // means direct-vs-via-bundle), so an installed row would fall back to
      // longest-configured-prefix — which reaches NO alias when the configured
      // entries are indexes, and the Installed tree then roots on the bare host
      // while Browse roots on the alias. The browse catalog holds grim's own
      // attribution for the very same repo; borrow it. An artifact absent from
      // the catalog keeps the fallback, as it must.
      const source = readSource(item?.source);
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
        installs: [...installs],
        ...(source ? { source } : {}),
        privateRegistry: isPrivateRegistry(registryHost(repo), authed, defaultRegistryHost),
        // Same borrow as `source`: `grim status` publishes no rating, so an
        // installed artifact absent from the browse catalog reads as unrated.
        rating: readRating(item?.rating),
        // Same borrow again — status carries no publish date either, and an
        // artifact the catalog does not know sorts into the undated bucket.
        updated: item?.created ?? null,
      });
    }
  }
  const cards = [...byRepo.values()];
  for (const card of cards) {
    card.state = rowState(card.deprecated, card.installs);
  }
  return cards;
}

/** The activity-bar update count for a set of scopes — the ONE derivation of
 *  that number. Both writers call it (the sidebar's refresh and activation's
 *  badge-only round), so they cannot answer differently; they used to derive it
 *  two ways and agree only by an invariant nothing enforced. Catalog items are
 *  deliberately not a parameter: they decorate cards (description, latest
 *  version, deprecation text) and change no field {@link hasUpdate} reads, which
 *  all come off the status rows. Callers gate on {@link firstUnknownScope}
 *  first. Pure. */
export function updateCount(scopes: ScopeStatus[]): number {
  return buildInstalledCards([], scopes).filter(hasUpdate).length;
}

/** The first scope whose install state is unknown, or undefined when every scope
 *  is readable — the ONE statement of the freeze rule. A count taken over a
 *  snapshot with an unknown scope silently undercounts (that scope contributes
 *  nothing, and nothing is indistinguishable from zero here), so both badge
 *  writers skip publishing rather than publish a number they can't stand behind;
 *  the sidebar reads the same call for its banner and its lastReady gate. Pure. */
export function firstUnknownScope(scopes: ScopeStatus[]): ScopeStatus | undefined {
  return scopes.find((s) => s.status === null);
}

export interface CardFilter {
  /** Selected kinds; EMPTY MEANS ALL (the "All" chip). */
  kinds: string[];
  /** Ordering for Browse and Installed — see {@link SortMode}. */
  sort: SortMode;
  dir: SortDir;
}

export const DEFAULT_FILTER: CardFilter = {
  kinds: [],
  sort: 'relevance',
  dir: 'asc',
};

/** Installed's seed. Its rows come from `grim status`, which ranks nothing, so
 *  `'relevance'` there would name an order that does not exist — name-first is
 *  the predictable answer, and the control does not offer relevance on that
 *  tab at all. */
export const DEFAULT_INSTALLED_FILTER: CardFilter = {
  ...DEFAULT_FILTER,
  sort: 'name',
  dir: 'asc',
};

/**
 * Which ordering the sort control applies.
 *
 * `'relevance'` is grim's OWN order — its fuzzy ranking for a queried browse,
 * registry-declaration order for an unqueried one — and it is Browse's default
 * for exactly that reason: sorting a typed query by name buries the best match.
 * It is offered on BROWSE ONLY; `grim status` ranks nothing, so Installed lists
 * name-first instead (see the sidebar's own filter seed). The other three
 * mirror grim's `--sort` (`browse_sort.rs`) and the index site's control,
 * bucket rules included.
 */
export type SortMode = 'relevance' | 'name' | 'updated' | 'rating';
export type SortDir = 'asc' | 'desc';

/** Each field's own direction — the one a reader means when they pick it.
 *  Choosing a field takes that field's natural direction: carrying the previous
 *  one over lands them on "oldest first" because they asked for Z-A a moment
 *  ago. */
export const NATURAL: Record<SortMode, SortDir> = {
  relevance: 'asc',
  name: 'asc',
  updated: 'desc',
  rating: 'desc',
};

/** Bigger first, with `null` as its own bucket UNDER every number: missing is
 *  not a low value. Folding it into one — unrated as 0 upvotes, undated as
 *  epoch 0 — orders those rows against real data by accident and ties them all
 *  with each other. grim's `browse_sort.rs` and the index site both do this. */
function descending(a: number | null, b: number | null): number {
  if (a === null || b === null) {
    return Number(a === null) - Number(b === null);
  }
  return b - a;
}

/** `created` as epoch ms; null when absent, empty, or not a date at all. */
function updatedAt(card: CardVM): number | null {
  const ms = card.updated ? new Date(card.updated).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

const byName = (a: CardVM, b: CardVM): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' }) || a.repo.localeCompare(b.repo);
const byUpdated = (a: CardVM, b: CardVM): number => descending(updatedAt(a), updatedAt(b));
const byRating = (a: CardVM, b: CardVM): number =>
  descending(a.rating?.up ?? null, b.rating?.up ?? null);

/** Each mode as a chain of keys, most significant first. Every chain ends on a
 *  key that is unique per row (the ref, through {@link byName}), so no two
 *  cards compare equal — an order that is not total reshuffles on every
 *  repaint. */
const CHAINS: Record<SortMode, ReadonlyArray<(a: CardVM, b: CardVM) => number>> = {
  relevance: [],
  name: [byName],
  updated: [byUpdated, byName],
  rating: [byRating, byUpdated, byName],
};

/** Orders cards for the sort control. `'relevance'` keeps grim's order as it
 *  arrived (reversing it is still meaningful — least relevant first). Reversed
 *  means reversed all the way down, the tiebreak included, which leaves the
 *  order just as total as it was. Pure; returns a new array. */
export function sortCards(cards: CardVM[], sort: SortMode, dir: SortDir): CardVM[] {
  if (sort === 'relevance') {
    return dir === NATURAL.relevance ? cards : [...cards].reverse();
  }
  const flip = dir === NATURAL[sort] ? 1 : -1;
  return [...cards].sort((a, b) => {
    for (const key of CHAINS[sort]) {
      const d = key(a, b);
      if (d !== 0) {
        return flip * d;
      }
    }
    return 0;
  });
}

/** Default install scope: project when a configured workspace is open (installs
 *  there need a grimoire.toml), else global. Pure. */
export function defaultScope(scopes: { projectOpen: boolean; projectConfigured: boolean }): Scope {
  return scopes.projectOpen && scopes.projectConfigured ? 'project' : 'global';
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

/** The kind filter, then the sort control's ordering — the ONE derivation both
 *  tabs and every id-computing caller share, so what is rendered and what the
 *  observer/grouping code walks can never disagree about order. */
export function filterCards(cards: CardVM[], filter: CardFilter): CardVM[] {
  const kept = cards.filter((card) => {
    if (filter.kinds.length > 0 && !(card.kind !== null && filter.kinds.includes(card.kind))) {
      return false;
    }
    return true;
  });
  return sortCards(kept, filter.sort, filter.dir);
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
    items: tab === 'updates' ? state.installedItems.filter(hasUpdate) : state.installedItems,
    query: tab === 'installed' ? installedQuery : '',
  };
}

/** The Installed view's shown cards: kind filter + name query, both scopes.
 *  No scope slice — the SCOPE toggle it used to serve was replaced by scope
 *  GROUPING (see {@link groupCards}), which shows both at once instead of
 *  hiding one behind a toggle. */
export function installedCards(state: SidebarState, filter: CardFilter): CardVM[] {
  return searchCards(filterCards(state.items, filter), state.query);
}

export function registriesOf(cards: CardVM[]): string[] {
  return [...new Set(cards.map((c) => c.registryHost))].sort();
}

/** How many registries a result set spans, for the footer and the empty state:
 *  the CONFIGURED registries of the searched scope when the host reported them
 *  (two aliases can share one host, which counting hosts undercounts), else the
 *  distinct hosts the cards themselves name. */
export function registryCount(state: Pick<SidebarState, 'registries' | 'items'>): number {
  return state.registries.length > 0 ? state.registries.length : registriesOf(state.items).length;
}

// --- Logo placeholder ---

/** How many avatar tints the stylesheet defines (.avatar-0 … .avatar-5). */
export const AVATAR_TINTS = 6;

/** The tint an artifact's monogram gets when it has no logo: a stable hash of
 *  its repo, so the same artifact keeps the same colour across refreshes and
 *  two artifacts side by side rarely collide. Deliberately a CLASS index and
 *  not a colour — the webview CSP blocks inline style=, so a computed hue
 *  cannot be applied per element. */
export function avatarTint(repo: string): number {
  // FNV-1a, 32-bit. Cheap, well-spread, and stable across runs (unlike any
  // hash that folds in object identity or iteration order).
  let hash = 0x811c9dc5;
  for (let i = 0; i < repo.length; i++) {
    hash ^= repo.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_TINTS;
}

/** The letters that stand in for a missing logo: the initials of the name's
 *  `-`/`_`/`.`-separated words, two at most ("grim-usage" → "GU"), falling back
 *  to the first character alone. Empty for an empty name — the caller renders an
 *  empty box rather than a lie. */
export function monogram(name: string): string {
  const initials = name
    .split(/[-_.\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0] ?? '')
    .join('');
  return initials.slice(0, 2).toUpperCase();
}

// --- View options: row density, flat-vs-tree, and the list's grouping key ---

// The shapes themselves live in protocol.ts — they ride the wire now that the
// host persists them as a preference — and are re-exported here so every
// existing `from './model'` import keeps working.
export type { Density, GroupKey, ViewMode, ViewOptions } from './protocol';

export const DEFAULT_VIEW: ViewOptions = {
  density: 'comfortable',
  mode: 'list',
  browseGroup: 'none',
  installedGroup: 'scope',
};

/** Each tab's group toggle: two states, so it flips rather than cycles. Updates
 *  is a short single-purpose list and never groups. */
export const GROUP_CYCLE: Record<SidebarTab, GroupKey[]> = {
  browse: ['none', 'registry'],
  installed: ['scope', 'none'],
  updates: ['none'],
};

/** The grouping key in force for a tab. */
export function groupKeyFor(tab: SidebarTab, view: ViewOptions): GroupKey {
  if (tab === 'browse') {
    return view.browseGroup;
  }
  return tab === 'installed' ? view.installedGroup : 'none';
}

/** Next key in the tab's cycle (wraps). An unknown current key restarts it. */
export function cycleGroup(tab: SidebarTab, current: GroupKey): GroupKey {
  const cycle = GROUP_CYCLE[tab];
  const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
  return next ?? 'none';
}

export interface CardGroup {
  /** Stable id — the repeat() key and the expanded-set key. */
  id: string;
  label: string;
  cards: CardVM[];
  /** Registry groups: a stored credential for this registry (renders the lock). */
  private?: boolean;
  /** Registry groups: this is the configured default registry. */
  isDefaultRegistry?: boolean;
}

export interface GroupContext {
  /** The configured registries of the scope that was searched. Grouping and the
   *  tree key on these; an empty list falls back to the repo's bare host. */
  registries?: RegistryVM[];
  projectName?: string | null;
}

/**
 * The configured registry a repo came from: the LONGEST matching `oci` prefix,
 * so "localhost:5050/grimoire" wins over a bare "localhost:5050" entry when
 * both are configured. This is the same fallback grim's own TUI applies to a
 * row it cannot attribute ("re-attributes by longest configured prefix",
 * RowSource::Unattributed).
 *
 * INDEX entries are skipped: an index serves rows from arbitrary hosts, so its
 * locator ("https://index.grimoire.rs") prefixes nothing. grim's TUI roots
 * those rows on their source because the catalog service hands it a per-row
 * RowSource — attribution that `grim search --format json` does NOT carry (no
 * source/alias field on a search item, plain or JSON). Until it does, a row
 * served by an index groups under its bare host, and inventing an alias for it
 * would be a guess presented as fact.
 *
 * Undefined when nothing claims the repo — including a card that outlived the
 * registry it was found through.
 */
export function registryFor(repo: string, registries: RegistryVM[]): RegistryVM | undefined {
  let best: RegistryVM | undefined;
  for (const registry of registries) {
    if (
      registry.kind === 'registry' &&
      (repo === registry.oci || repo.startsWith(`${registry.oci}/`)) &&
      (best === undefined || registry.oci.length > best.oci.length)
    ) {
      best = registry;
    }
  }
  return best;
}

/** How a card is filed under registry grouping. grim's search JSON attributes
 *  every row to the configured entry it was browsed from, and that attribution
 *  wins: it is the only thing that can root an INDEX-served row under the alias
 *  the user gave the index, since the index's locator prefixes no repo. Without
 *  it (installed-only cards, an older grim) we fall back to the longest
 *  configured prefix, then to the bare host — grim's own `RowSource`
 *  attribution order.
 *
 *  The id is the ALIAS when there is one: two entries can share a locator (one
 *  index browsed twice under different browse filters is exactly that), and
 *  keying on the locator merged them into one group. An entry with NO alias is
 *  labelled by its locator — never "default", which already means the default
 *  registry. */
function registryBucket(
  card: Pick<CardVM, 'repo' | 'source'>,
  registries: RegistryVM[],
): { id: string; label: string; isDefault: boolean; private: boolean } {
  const source = card.source;
  if (source) {
    // Match the entry back for its flags. Alias first — an alias is unique
    // within a scope, while the same locator may be declared by two entries.
    const entry =
      registries.find((r) => r.alias !== null && r.alias === source.alias) ??
      registries.find((r) => r.oci === source.locator);
    return {
      id: source.alias ?? source.locator,
      label: source.alias ?? source.locator,
      isDefault: entry?.isDefault === true,
      private: entry?.authenticated === true,
    };
  }
  const registry = registryFor(card.repo, registries);
  if (!registry) {
    const host = registryHost(card.repo);
    return { id: host, label: host, isDefault: false, private: false };
  }
  return {
    id: registry.alias ?? registry.oci,
    label: registry.alias ?? registry.oci,
    isDefault: registry.isDefault,
    private: registry.authenticated === true,
  };
}

/** The path a card occupies UNDER its registry root, as grim's TUI splits it:
 *  strip the longest configured locator that prefixes the reference at a `/`
 *  boundary; failing that, an attributed row keeps its FULL reference (an index
 *  root legitimately holds rows from several hosts, so the host is information
 *  there) and an unattributed one drops its bare host (the host IS its root). */
function relativePath(card: Pick<CardVM, 'repo' | 'source'>, registries: RegistryVM[]): string {
  const registry = registryFor(card.repo, registries);
  if (registry) {
    return card.repo.slice(registry.oci.length + 1);
  }
  return card.source ? card.repo : card.repo.split('/').slice(1).join('/');
}

/** Splits cards into ordered groups for the list's group headers. 'none' is
 *  handled by the caller (it renders flat), so it is not a key here.
 *
 *  Registry: one group per configured registry, named by its alias, default
 *  first. Scope: Project then Global, each holding the cards with an install in
 *  it — so an artifact installed in both appears twice, once per group. Pure. */
export function groupCards(
  cards: CardVM[],
  key: Exclude<GroupKey, 'none'>,
  context: GroupContext = {},
): CardGroup[] {
  if (key === 'scope') {
    const scopes: Scope[] = ['project', 'global'];
    return scopes
      .map((scope) => ({
        id: scope,
        label:
          scope === 'project'
            ? `Project${context.projectName ? ` — ${context.projectName}` : ''}`
            : 'Global',
        cards: cards.filter((c) => c.installs.some((i) => i.scope === scope)),
      }))
      .filter((g) => g.cards.length > 0);
  }
  // Registry: one group per CONFIGURED registry that claims a card, default
  // first, then by label. Cards no configured registry claims fall back to
  // their bare host, and those buckets sort last.
  const registries = context.registries ?? [];
  const buckets = new Map<string, CardGroup>();
  for (const card of cards) {
    const bucket = registryBucket(card, registries);
    const existing = buckets.get(bucket.id);
    if (existing) {
      existing.cards.push(card);
      continue;
    }
    buckets.set(bucket.id, {
      id: bucket.id,
      label: bucket.label,
      cards: [card],
      private: bucket.private,
      isDefaultRegistry: bucket.isDefault,
    });
  }
  return [...buckets.values()].sort(byDefaultRegistryFirst);
}

/** The default registry leads; the rest go alphabetically by the label the user
 *  actually sees (the alias). */
function byDefaultRegistryFirst(a: CardGroup, b: CardGroup): number {
  if (a.isDefaultRegistry !== b.isDefaultRegistry) {
    return a.isDefaultRegistry === true ? -1 : 1;
  }
  return a.label.localeCompare(b.label);
}

// --- Tree ---

export interface TreeNode {
  /** Stable id — the repeat() key AND the expanded-set key. The full path from
   *  the tree root down to this node, so a refreshed catalog keeps the tree
   *  open exactly where the user left it. */
  id: string;
  label: string;
  /** Group nodes only; a leaf has none. */
  children: TreeNode[];
  /** Leaf payload. Its presence is what makes a node a leaf. */
  card?: CardVM;
  /** Leaves in this subtree (1 for a leaf). */
  count: number;
  /** Registry-root nodes: a stored credential for this host. */
  private?: boolean;
  /** Registry-root nodes: the configured default registry. */
  isDefaultRegistry?: boolean;
}

/** Builds the registry → namespace → artifact tree, matching grim's own TUI
 *  tree so the two views never disagree about shape (see
 *  ../grimoire/test/manual/README.md scenario 1c):
 *
 *  - **Roots are the configured registries**, named by their alias. The
 *    registry's own `oci` prefix (host + namespace) is stripped from the paths
 *    below it — it is the root, so repeating it in every child is noise.
 *  - **Longest-empty-prefix fold**: a chain of single-child GROUP nodes joins
 *    into one row ("playbooks/ci/release"). The namespace directly above a
 *    package is kept — a group whose only child is a leaf never absorbs it.
 *  - **Root elision**: with exactly one registry in the result set, the root
 *    row carries no information, so its children become the roots.
 *
 *  Groups sort before leaves: groups alphabetically, LEAVES in the order the
 *  sort control put them in — a tree that re-alphabetized its artifacts made
 *  the control look broken everywhere but the flat list. Pure. */
export function buildTree(cards: CardVM[], context: GroupContext = {}): TreeNode[] {
  const registries = context.registries ?? [];
  const roots = groupCards(cards, 'registry', context).map((group) => {
    // The path under a root is per CARD, not per root: an index root
    // legitimately holds rows from several hosts, so there is no one prefix to
    // strip for the whole group.
    const placed = group.cards.map((card) => ({
      card,
      segments: relativePath(card, registries).split('/'),
    }));
    const node: TreeNode = {
      id: group.id,
      label: group.label,
      children: foldChains(namespaceChildren(group.id, placed, 0)),
      count: group.cards.length,
    };
    if (group.private === true) {
      node.private = true;
    }
    if (group.isDefaultRegistry === true) {
      node.isDefaultRegistry = true;
    }
    return node;
  });
  return roots.length === 1 && roots[0] ? roots[0].children : roots;
}

/** A card together with its `/`-split path under its registry root. */
interface PlacedCard {
  card: CardVM;
  segments: string[];
}

/** One level of a registry's subtree. `depth` counts the path segments already
 *  consumed by ancestor levels, so each level splits only what is left. A card
 *  with one segment remaining is the artifact itself: a leaf. */
function namespaceChildren(parentId: string, placed: PlacedCard[], depth: number): TreeNode[] {
  const groups = new Map<string, PlacedCard[]>();
  const leaves: TreeNode[] = [];
  for (const entry of placed) {
    const segments = entry.segments.slice(depth);
    const head = segments.length > 1 ? segments[0] : undefined;
    if (head === undefined) {
      // Keyed by repo, not by path: unique, and stable across a refresh even if
      // the artifact's display name changes.
      leaves.push({
        id: entry.card.repo,
        label: entry.card.name,
        children: [],
        count: 1,
        card: entry.card,
      });
      continue;
    }
    const bucket = groups.get(head);
    if (bucket) {
      bucket.push(entry);
    } else {
      groups.set(head, [entry]);
    }
  }
  const groupNodes = [...groups.entries()].map(([segment, inSegment]) => {
    const id = `${parentId}/${segment}`;
    return {
      id,
      label: segment,
      children: namespaceChildren(id, inSegment, depth + 1),
      count: inSegment.length,
    };
  });
  // Leaves arrive in the order filterCards left them (the sort control's), and
  // keep it. Groups have no card of their own to rank, so they stay
  // alphabetical whatever the strategy is.
  return [...sortByLabel(groupNodes), ...leaves];
}

function sortByLabel(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => a.label.localeCompare(b.label));
}

/** Joins single-child group chains into one node, depth-first. A group whose
 *  only child is a LEAF is left alone — the namespace directly above a package
 *  carries information the fold would destroy. */
function foldChains(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.card) {
      return node;
    }
    const children = foldChains(node.children);
    const only = children.length === 1 ? children[0] : undefined;
    // The child is already maximally folded (depth-first), so one join is all
    // it takes — a chain of any length collapses from the bottom up. Its id
    // (the deepest path) becomes the folded row's id.
    return only && !only.card
      ? { ...only, label: `${node.label}/${only.label}` }
      : { ...node, children };
  });
}

/** Every group node's id, for expand-all. */
export function collectNodeIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.card ? [] : [n.id, ...collectNodeIds(n.children)]));
}

/** The ids expanded on a first visit: the top level only, so the tree opens
 *  showing its shape rather than every artifact at once. */
export function topLevelIds(nodes: TreeNode[]): string[] {
  return nodes.filter((n) => !n.card).map((n) => n.id);
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
  // One entry per scope with materialization drift. Labelled by scope because
  // that is genuinely what runs: `grim install` re-materializes the scope's
  // whole lock, there being no way to target one artifact.
  for (const install of card.installs.filter((i) => hasOutputsPending(i))) {
    entries.push({
      label: `Complete Install (${install.scope === 'project' ? 'Project' : 'Global'})`,
      action: 'complete-install',
      data: { scope: install.scope },
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
      // Deprecated with a named successor → offer a one-click switch next to
      // Uninstall, per scope (install replacement here, then uninstall this).
      // Only for direct installs — a via-bundle row's old copy can't be removed.
      if (card.replacedBy) {
        entries.push({
          label: `Switch to ${card.replacedBy} (${label})`,
          action: 'switch',
          data: {
            kind: install.kind,
            name: install.name,
            scope: install.scope,
            replacedBy: card.replacedBy,
          },
        });
      }
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
 * per-row). What is left are the actions a via-bundle row cannot reach from its
 * split button, because that button is the `Bundle` nav: Update when it is
 * outdated, Complete Install when an install would still write for it. Every
 * other row's gear is empty and hidden (see scopeGear).
 */
export function scopeRowMenuEntries(install: InstallVM | null): MenuEntry[] {
  if (!install || install.viaBundles.length === 0) {
    return [];
  }
  const entries: MenuEntry[] = [];
  if (install.updateAvailable) {
    entries.push({
      label: 'Update',
      action: 'update',
      data: { kind: install.kind, name: install.name, scope: install.scope },
    });
  }
  if (hasOutputsPending(install)) {
    entries.push({
      label: 'Complete Install',
      action: 'complete-install',
      data: { scope: install.scope },
    });
  }
  return entries;
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

// --- Add-registry deep link (…/add-registry?index=<url>&alias=<name>) ---
// Unlike /open, this one WRITES: an index website offers a one-click "add this
// index". Any web page can navigate to the URI, so everything below treats the
// query as hostile — the host still confirms modally before writing.

/** A validated add-registry link. `index` is the normalized URL, which is both
 *  what the modal shows and what is written — never the raw query value.
 *  `include`/`exclude` are browse-filter globs, `[]` when the link carries
 *  none. */
export interface AddRegistryLink {
  alias: string;
  index: string;
  include: string[];
  exclude: string[];
}

/** Alias charset: TOML bare-key safe (a `.` would split the key path, quotes
 *  and brackets would break out of it) and flag-safe (never a leading `-`).
 *  Rejected outright rather than escaped — nothing legitimate needs the rest. */
const REGISTRY_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** The whole charset a browse-filter pattern may use: printable ASCII, space
 *  excluded. Not a glob-syntax rule — grim owns that, and rejects an
 *  uncompilable pattern with exit 65. This is about the CONFIRMATION: the modal
 *  authorizes the write and renders each pattern as a plain line, so a `\n` or
 *  U+2028 forges an extra "Index:" line, a bidi override reverses one, a run of
 *  spaces forges one without a break, and a zero-width character hides part of
 *  what is being asked for. An ALLOWLIST, because enumerating those accepts
 *  every code point nobody thought of; OCI repository paths and globset
 *  metacharacters (`* ? [ ] { }`) are ASCII by specification, so nothing
 *  legitimate is lost. `index` needs no equivalent — `URL.href` percent-encodes
 *  everything outside this range already. */
const FILTER_PATTERN_CHARS = /^[\x21-\x7e]+$/;

/** Caps on a link's pattern lists. Grim itself caps neither (it compiles each
 *  GlobSet once per registry at config load, so count costs it nothing) — these
 *  exist because the modal has to render every pattern legibly, and
 *  showWarningMessage's detail neither scrolls nor documents a limit. Violating
 *  either rejects the whole link rather than truncating: a confirmation that
 *  shows fewer patterns than it writes is worse than no link at all. */
const MAX_FILTER_PATTERNS = 10;
const MAX_FILTER_PATTERN_LENGTH = 200;

/** Reads one repeated query parameter as a pattern list, or null when any
 *  entry — or the list itself — is outside what the modal can honestly show.
 *  An empty or blank entry fails {@link FILTER_PATTERN_CHARS} like any other. */
function parseFilterPatterns(
  params: URLSearchParams,
  key: string,
  onReject: (reason: string) => void,
): string[] | null {
  const patterns = params.getAll(key);
  if (patterns.length > MAX_FILTER_PATTERNS) {
    onReject(`more than ${MAX_FILTER_PATTERNS} ${key} patterns`);
    return null;
  }
  for (const pattern of patterns) {
    if (pattern.length > MAX_FILTER_PATTERN_LENGTH) {
      onReject(`${key} pattern longer than ${MAX_FILTER_PATTERN_LENGTH} characters`);
      return null;
    }
    if (!FILTER_PATTERN_CHARS.test(pattern)) {
      onReject(`${key} pattern outside printable ASCII`);
      return null;
    }
  }
  return patterns;
}

/**
 * Reads `?index=<url>&alias=<name>&include=<p>&exclude=<p>` out of an
 * /add-registry query string, or null when it is anything grim should not be
 * handed.
 *
 * `include`/`exclude` repeat once per pattern and are NEVER comma-separated:
 * a comma is glob alternation syntax, so `acme/{platform,tools}/**` is one
 * pattern, and grim's own flags do not split either.
 *
 * `https:` only: an index locator is fetched with whatever credentials the
 * user configures for it, so a link that downgrades to plain http is refused
 * rather than silently accepted. Embedded credentials are refused too — the
 * link would otherwise persist a secret into grimoire.toml.
 *
 * The returned `index` is `URL.href`, not the raw parameter: URL parsing
 * strips tabs and newlines the query can legally carry, so normalizing here is
 * what guarantees the string in the confirmation modal is byte-for-byte the
 * string that reaches the config file.
 *
 * `onReject` names which rule refused the link, for the caller's log — a
 * rejected link is otherwise indistinguishable from a dead click. It quotes NO
 * query value: the log must not become a second surface a page can forge lines
 * in, and nothing here is ever shown to the user.
 */
export function parseAddRegistryLink(
  query: string,
  onReject: (reason: string) => void = () => {},
): AddRegistryLink | null {
  const params = new URLSearchParams(query);
  const alias = params.get('alias') ?? '';
  const index = params.get('index') ?? '';
  if (!REGISTRY_ALIAS.test(alias)) {
    onReject('alias is not a bare, flag-safe identifier');
    return null;
  }
  let url: URL | undefined;
  if (index.length <= 2048) {
    try {
      url = new URL(index);
    } catch {
      url = undefined;
    }
  }
  if (!url || url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    onReject('index is not a plain https URL under 2048 characters');
    return null;
  }
  const include = parseFilterPatterns(params, 'include', onReject);
  if (include === null) {
    return null;
  }
  const exclude = parseFilterPatterns(params, 'exclude', onReject);
  if (exclude === null) {
    return null;
  }
  return { alias, index: url.href, include, exclude };
}

/** One "Include: …" / "Exclude: …" clause, continuation lines hanging under
 *  the label. Empty lists produce nothing at all rather than "Include: none" —
 *  same "empty panels are omitted" rule the panels follow. */
function patternClause(label: string, patterns: string[]): string {
  if (patterns.length === 0) {
    return '';
  }
  const indent = ' '.repeat(label.length + 2);
  return `\n${label}: ${patterns.join(`\n${indent}`)}`;
}

/** Where an add-registry link writes, plus the modal text that says so. The
 *  Settings UX defaults to project scope; with no folder open there is no
 *  project config to write, so it falls back to global — named in the modal
 *  rather than done silently, since global is a machine-wide change.
 *
 *  Every pattern is listed in full: this modal IS the authorization, so it
 *  must show exactly what reaches grimoire.toml — the same reason the index is
 *  the normalized URL. parseAddRegistryLink has already rejected any link whose
 *  lists are too long or carry a character that could forge a line here. The
 *  clause about what a filter does not do sits with the trust sentence, because
 *  "excluded" reads like access control and is not: a direct reference to a
 *  hidden package still resolves and installs.
 *
 *  ORDER IS PART OF THE CONTROL. The pattern block goes LAST, under the
 *  sentence that says where this writes: `showWarningMessage`'s detail neither
 *  scrolls nor truncates, and the caps still allow thousands of characters of
 *  page-supplied pattern text — enough, with no special characters at all, to
 *  push whatever follows it out of view. */
export function addRegistryPrompt(
  link: AddRegistryLink,
  projectOpen: boolean,
): { scope: Scope; detail: string } {
  const scope: Scope = projectOpen ? 'project' : 'global';
  const where =
    scope === 'project'
      ? "this project's grimoire.toml"
      : 'your GLOBAL grimoire.toml — no folder is open, so there is no project config to write';
  const filters = patternClause('Include', link.include) + patternClause('Exclude', link.exclude);
  const filterNote = filters
    ? ' These patterns only narrow what browsing shows — they do not stop anything from being installed.'
    : '';
  return {
    scope,
    detail:
      `A web page is asking to add an index registry.\n\nIndex: ${link.index}\nAlias: ${link.alias}\n\n` +
      `This writes to ${where}. Only continue if you trust that page.${filterNote}` +
      (filters ? `\n${filters}` : ''),
  };
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
    // Additive on grim's frozen interface — optional here for the same reason
    // they are optional in grim.ts's DescribeResult: an older grim omits them.
    authors?: string | null;
    vendor?: string | null;
    url?: string | null;
    documentation?: string | null;
    compatibility?: string | null;
    support?: WireSupport;
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
    authors: null,
    vendor: null,
    homepage: null,
    documentation: null,
    compatibility: null,
    support: readSupport(undefined),
    keywords: null,
    logoUri: null,
    rating: readRating(searchItem?.rating),
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
export function isInteractiveTarget(el: { closest(selector: string): unknown } | null): boolean {
  return (el?.closest(INTERACTIVE_SELECTOR) ?? null) !== null;
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
    // No frontmatter counterpart exists for any of these: grim derives them or
    // reads them off the manifest, so describe is the only source.
    authors: describe?.authors ?? null,
    vendor: describe?.vendor ?? null,
    homepage: describe?.url ?? null,
    documentation: describe?.documentation ?? null,
    compatibility: describe?.compatibility ?? null,
    support: readSupport(describe?.support),
    keywords: describe?.keywords ?? frontmatter?.keywords ?? null,
    logoUri: sources.logoUri,
    // Only `grim search` publishes a rating; describe/fetch carry none, so the
    // catalog row is the single source and an absent row means unrated.
    rating: readRating(searchItem?.rating),
    busy: null,
    error: null,
  };
}
