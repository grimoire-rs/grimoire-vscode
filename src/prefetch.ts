// Background prefetch of browse-list items into the details snapshot cache, so
// opening an artifact paints instantly and card logos pop in as they land.
// Pure scheduling (no vscode/DOM): work + freshness + repost are injected.

// ponytail: tuning constants — bounded fan-out and capped parallel grim spawns
// keep this cheap at thousands-of-skills scale. Raise if telemetry says so.
const TOP_K = 24;
const CONCURRENCY = 6;
const REPOST_DEBOUNCE_MS = 500;

export interface PrefetchDeps {
  /** Runs the content pipeline for a repo → cache save. */
  work: (repo: string) => Promise<void>;
  /** True when the repo's cached snapshot is young enough to skip it. */
  isFresh: (repo: string) => Promise<boolean>;
  /** Called (debounced) after a burst of cache writes produced card
   *  decorations (a logo, or a describe-resolved latest version). */
  onCardMetaLanded: () => void;
  /** Prefetch is a no-op while this returns false (grimoire.prefetchDetails). */
  enabled: () => boolean;
}

export class Prefetcher {
  private pending: string[] = [];
  private readonly inFlight = new Set<string>();
  private disposed = false;
  private metaTimer: ReturnType<typeof setTimeout> | undefined;
  /** Monotonic enqueue generation — see enqueue's freshness loop. */
  private generation = 0;

  constructor(private readonly deps: PrefetchDeps) {}

  /** Enqueue the top-K uncached repos of a fresh result list. New results clear
   *  the pending queue (in-flight items just finish); fire-and-forget.
   *
   *  `force` skips the freshness probe, so an explicit refresh ("Check for
   *  updates", the refresh button) re-resolves every top-K repo instead of
   *  trusting a cache entry that is younger than the 6h TTL. That entry is what
   *  a browse row's version comes from behind an index registry, so without this
   *  a newly published version stayed invisible for hours no matter how often
   *  the user hit refresh. */
  async enqueue(repos: string[], options: { force?: boolean } = {}): Promise<void> {
    if (this.disposed || !this.deps.enabled()) {
      return;
    }
    // The freshness probes below are async (each reads the cache off disk), and
    // enqueue is called per search — a burst of keystrokes overlaps several. The
    // generation makes the LAST caller the one that owns the queue: without it a
    // slow older round finished after a newer one and assigned its own, older
    // result list on top, so the prefetch chased results that were already gone.
    const generation = ++this.generation;
    const uncached: string[] = [];
    for (const repo of repos.slice(0, TOP_K)) {
      if (this.inFlight.has(repo) || uncached.includes(repo)) {
        continue;
      }
      if (options.force === true || !(await this.deps.isFresh(repo))) {
        uncached.push(repo);
      }
    }
    if (generation !== this.generation) {
      return; // superseded — the newer enqueue's list is the one to pump
    }
    this.pending = uncached; // new results replace the queue
    this.pump();
  }

  private pump(): void {
    while (!this.disposed && this.inFlight.size < CONCURRENCY && this.pending.length > 0) {
      const repo = this.pending.shift() as string;
      if (this.inFlight.has(repo)) {
        continue;
      }
      this.inFlight.add(repo);
      void this.run(repo);
    }
  }

  private async run(repo: string): Promise<void> {
    try {
      await this.deps.work(repo);
    } catch {
      // No retry — a failed prefetch just falls back to the normal cold open.
    } finally {
      this.inFlight.delete(repo);
      this.pump();
    }
  }

  /** A card decoration (logo or resolved version) landed in the details cache —
   *  from ANY path, prefetch or a details panel open (the cache reports it at
   *  its save choke point). Single trailing
   *  repost per burst: coalesce logo landings within the window. The debounce
   *  lives here because this object owns the disposable timer wired to the
   *  sidebar; the prefetch loop no longer signals it directly. */
  notifyCardMeta(): void {
    if (this.metaTimer || this.disposed) {
      return;
    }
    this.metaTimer = setTimeout(() => {
      this.metaTimer = undefined;
      if (!this.disposed) {
        this.deps.onCardMetaLanded();
      }
    }, REPOST_DEBOUNCE_MS);
  }

  /** Fire-and-forget on deactivate: stop pumping, in-flight grim calls just
   *  finish (their cache.save is harmless), the timer is cleared. */
  dispose(): void {
    this.disposed = true;
    this.pending = [];
    if (this.metaTimer) {
      clearTimeout(this.metaTimer);
      this.metaTimer = undefined;
    }
  }
}
