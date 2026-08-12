// Persistent per-repo details snapshot store. Lets a reopened details panel
// paint real content (README/logo/changelog/describe/fetch) instantly from disk
// while grim revalidates in the background (stale-while-revalidate in
// views/details.ts). Install/scope state is NEVER cached — it is always resolved
// fresh from grim, so only the slow content pieces live here.
//
// No vscode import: the storage directory is injected (the extension wires
// globalStorageUri/details-cache) so this module stays testable with a tmp dir.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DescribeResult, FetchResult } from './grim';

/** Bump to invalidate every on-disk entry (schema or content-semantics change).
 *  Unversioned/mismatched entries — e.g. describes cached before the legacy path
 *  was deleted — self-purge on load instead of lingering as confusing state. */
export const CACHE_VERSION = 1;

export interface DetailsCacheEntry {
  version: number;
  repo: string;
  /** Artifact manifest digest at save time — compared against a fresh
   *  `fetch --digest-only` to decide whether the cached paint is still fresh. */
  artifactDigest: string | null;
  /** Description companion digest at save time (null when none). */
  companionDigest: string | null;
  savedAt: string;
  describe: DescribeResult | null;
  fetch: FetchResult | null;
  readme: string | null;
  logoUri: string | null;
  changelog: string | null;
  /** False when this snapshot is missing a doc the artifact is known to
   *  publish — a probe that partly failed. It still paints (merged content is
   *  never worse than what was there), but it gets the SHORT retry TTL instead
   *  of the full one, so a transient failure costs minutes, not hours.
   *  Optional: an entry written before this field reads as incomplete, which
   *  re-probes it once and then settles. */
  complete?: boolean;
}

/** Folds a fresh snapshot onto the cached one so a probe can only ever ADD
 *  content. A partly-failed pipeline yields nulls for the pieces it could not
 *  resolve (a companion fetch that failed leaves `logoUri: null`), and writing
 *  those over a good entry is what made browse-list logos vanish: the null was
 *  stamped fresh and the row was skipped until the TTL expired. Deliberate
 *  eviction is still {@link DetailsCache.forget} / a CACHE_VERSION bump.
 *
 *  `fetch` and the digests always come from the fresh run — they describe the
 *  probe that just happened, and a stale digest would defeat the freshness
 *  check itself. */
export function mergeEntry(
  cached: DetailsCacheEntry | null,
  fresh: DetailsCacheEntry,
): DetailsCacheEntry {
  // A COMPLETE probe replaces the entry outright. Folding is a repair for a
  // probe that failed, and a complete probe did not fail — so a null in it is
  // the publisher's answer, not a lost byte, and honouring it is how a deleted
  // logo or README actually disappears. Without this the fold made every
  // removal unpropagatable: the old content came back under the new digest and
  // stayed until the cache was evicted by hand.
  if (!cached || fresh.complete === true) {
    return fresh;
  }
  return {
    ...fresh,
    describe: fresh.describe ?? cached.describe,
    readme: fresh.readme ?? cached.readme,
    logoUri: fresh.logoUri ?? cached.logoUri,
    changelog: fresh.changelog ?? cached.changelog,
  };
}

/** Everything a rendered details panel takes from an entry, as one comparable
 *  string — the answer to "would the user see anything different?".
 *
 *  Lives here, beside {@link cardMetaOf}, for the same reason: one place decides
 *  what a surface reads out of an entry. The revalidate repost used to compare
 *  digests instead, which is wrong in both directions — an incomplete probe
 *  nulls the digest, so a retry that recovered a logo compared null-to-null and
 *  never reposted, while a merged entry whose content the fold left identical
 *  still differed by digest and reposted a flicker.
 *
 *  Key order is written out rather than taken from the object, so the signature
 *  cannot change with how the entry was built. `describe` and `fetch` are grim's
 *  own JSON: stable per digest (annotations are a BTreeMap, optional fields are
 *  skip_serializing_if), so the residual risk is a single self-healing spurious
 *  repost if a future grim reorders a struct's fields. */
export function paintSignature(entry: DetailsCacheEntry): string {
  return JSON.stringify({
    describe: entry.describe,
    fetch: entry.fetch,
    readme: entry.readme,
    logoUri: entry.logoUri,
    changelog: entry.changelog,
  });
}

/** What a cached snapshot lends a sidebar card: the artifact logo and the
 *  describe-resolved latest version. Either may be null; an entry with both
 *  null decorates nothing and is omitted. */
export interface CachedCardMeta {
  logoUri: string | null;
  version: string | null;
}

/** The card slice of an entry, or null when it carries neither piece. The one
 *  place that decides what "has something to decorate a card with" means —
 *  {@link DetailsCache.presentCardMeta} reads it, and details.ts fires its
 *  sidebar repost off the same predicate, so a save that lands a version
 *  cannot go unreported. */
export function cardMetaOf(entry: DetailsCacheEntry | null): CachedCardMeta | null {
  const logoUri = entry?.logoUri ?? null;
  const version = entry?.describe?.version ?? null;
  return logoUri === null && version === null ? null : { logoUri, version };
}

/** Newest N snapshot files kept on save; older ones pruned by mtime.
 *  ponytail: fixed ceiling, not an LRU — a details cache is a nicety, not a
 *  budget to manage. Sized for the background prefetch (top-K per search over a
 *  session); raise it if users routinely browse more repos than this. */
const MAX_ENTRIES = 256;

function hashName(repo: string): string {
  return `${createHash('sha1').update(repo).digest('hex')}.json`;
}

/** Per-write suffix for the staging file (see save). Process-local, paired with
 *  the pid so two windows sharing globalStorage can't collide either. */
let tmpSeq = 0;

export class DetailsCache {
  // maxEntries is injectable so prune tests don't have to write 256 files.
  constructor(
    private readonly dir: string,
    private readonly maxEntries: number = MAX_ENTRIES,
  ) {}

  private fileFor(repo: string): string {
    return path.join(this.dir, hashName(repo));
  }

  /** Cached entry for a repo, or null when absent/unreadable/corrupt. A corrupt
   *  file is deleted so it can't poison future loads. */
  async load(repo: string): Promise<DetailsCacheEntry | null> {
    const file = this.fileFor(repo);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return null;
    }
    try {
      const entry = JSON.parse(raw) as DetailsCacheEntry;
      // Trust only a same-repo, current-version entry (a hash collision, hand
      // edit, or pre-cleanup schema could point elsewhere / be stale) — else
      // delete so it can't poison future loads.
      if (entry.repo === repo && entry.version === CACHE_VERSION) {
        return entry;
      }
      await fs.rm(file, { force: true }).catch(() => {});
      return null;
    } catch {
      await fs.rm(file, { force: true }).catch(() => {});
      return null;
    }
  }

  /** Card decorations for the cached subset of `repos` (misses omitted). Reads
   *  the directory once and loads only the hits, so cost is O(cache size), not
   *  O(repos) — cheap to call per sidebar render at thousands-of-catalog scale.
   *
   *  `version` is the describe-resolved latest tag, and it is what an
   *  index-backed row has no other source for: an index is a phone book, so
   *  `grim search` reports `version`/`latest_tag` as null for every repo behind
   *  one, and only a live describe knows the tag. */
  async presentCardMeta(repos: string[]): Promise<Map<string, CachedCardMeta>> {
    const names = new Set(await fs.readdir(this.dir).catch(() => [] as string[]));
    const out = new Map<string, CachedCardMeta>();
    await Promise.all(
      repos.map(async (repo) => {
        if (!names.has(hashName(repo))) {
          return;
        }
        const entry = await this.load(repo);
        const meta = cardMetaOf(entry);
        if (meta) {
          out.set(repo, meta);
        }
      }),
    );
    return out;
  }

  /** Drops the repo's entry, so the next read misses and re-resolves. Called
   *  after a mutating action on that artifact: the 6h TTL is right for a
   *  background sweep and wrong for the artifact the user just changed. */
  async forget(repo: string): Promise<void> {
    await fs.rm(this.fileFor(repo), { force: true }).catch(() => {});
  }

  /** Overwrites the repo's entry in place (latest-only, no version history),
   *  then prunes the directory back to the newest MAX_ENTRIES files. */
  async save(repo: string, entry: DetailsCacheEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    // Write-then-rename so a concurrent load never parses a half-written file and
    // deletes the good entry (rename is atomic within a dir). The .tmp suffix
    // keeps it out of prune's `.json` filter. The name is unique PER WRITE, not
    // per repo: two saves for one repo overlap routinely (a panel open racing
    // the prefetch of the same card), and a shared tmp path let both write into
    // ONE file — interleaved, so the rename published a torn document. Racing
    // saves still last-write-win at the rename; each writes a whole entry now.
    const file = this.fileFor(repo);
    const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ ...entry, version: CACHE_VERSION }));
      await fs.rename(tmp, file);
    } catch (error) {
      // A crashed write leaves no orphan behind (the rename is what consumes it).
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    await this.prune();
  }

  private async prune(): Promise<void> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const files = names.filter((n) => n.endsWith('.json'));
    if (files.length <= this.maxEntries) {
      return;
    }
    const stats = await Promise.all(
      files.map(async (name) => {
        const full = path.join(this.dir, name);
        const stat = await fs.stat(full).catch(() => null);
        return { full, mtime: stat ? stat.mtimeMs : 0 };
      }),
    );
    stats.sort((a, b) => b.mtime - a.mtime); // newest first
    await Promise.all(
      stats.slice(this.maxEntries).map((s) => fs.rm(s.full, { force: true }).catch(() => {})),
    );
  }
}
