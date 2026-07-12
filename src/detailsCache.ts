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
}

/** Newest N snapshot files kept on save; older ones pruned by mtime.
 *  ponytail: fixed ceiling, not an LRU — a details cache is a nicety, not a
 *  budget to manage. Sized for the background prefetch (top-K per search over a
 *  session); raise it if users routinely browse more repos than this. */
const MAX_ENTRIES = 256;

function hashName(repo: string): string {
  return `${createHash('sha1').update(repo).digest('hex')}.json`;
}

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

  /** Logo data-URIs for the cached subset of `repos` (misses omitted). Reads the
   *  directory once and loads only the hits, so cost is O(cache size), not
   *  O(repos) — cheap to call per sidebar render at thousands-of-catalog scale. */
  async presentLogos(repos: string[]): Promise<Map<string, string>> {
    const names = new Set(await fs.readdir(this.dir).catch(() => [] as string[]));
    const out = new Map<string, string>();
    await Promise.all(
      repos.map(async (repo) => {
        if (!names.has(hashName(repo))) {
          return;
        }
        const entry = await this.load(repo);
        if (entry?.logoUri) {
          out.set(repo, entry.logoUri);
        }
      }),
    );
    return out;
  }

  /** Overwrites the repo's entry in place (latest-only, no version history),
   *  then prunes the directory back to the newest MAX_ENTRIES files. */
  async save(repo: string, entry: DetailsCacheEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    // Write-then-rename so a concurrent load never parses a half-written file and
    // deletes the good entry (rename is atomic within a dir). The .tmp suffix
    // keeps it out of prune's `.json` filter. ponytail: shared tmp name, so racing
    // saves to one repo last-write-win — a details snapshot isn't worth per-repo locks.
    const file = this.fileFor(repo);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ ...entry, version: CACHE_VERSION }));
    await fs.rename(tmp, file);
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
