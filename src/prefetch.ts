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
  /** Called (debounced) after a burst of cache writes produced logos. */
  onLogosLanded: () => void;
  /** Prefetch is a no-op while this returns false (grimoire.prefetchDetails). */
  enabled: () => boolean;
}

export class Prefetcher {
  private pending: string[] = [];
  private readonly inFlight = new Set<string>();
  private disposed = false;
  private logoTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: PrefetchDeps) {}

  /** Enqueue the top-K uncached repos of a fresh result list. New results clear
   *  the pending queue (in-flight items just finish); fire-and-forget. */
  async enqueue(repos: string[]): Promise<void> {
    if (this.disposed || !this.deps.enabled()) {
      return;
    }
    const uncached: string[] = [];
    for (const repo of repos.slice(0, TOP_K)) {
      if (this.inFlight.has(repo) || uncached.includes(repo)) {
        continue;
      }
      if (!(await this.deps.isFresh(repo))) {
        uncached.push(repo);
      }
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

  /** A logo landed in the details cache — from ANY path, prefetch or a details
   *  panel open (the cache reports it at its save choke point). Single trailing
   *  repost per burst: coalesce logo landings within the window. The debounce
   *  lives here because this object owns the disposable timer wired to the
   *  sidebar; the prefetch loop no longer signals it directly. */
  notifyLogo(): void {
    if (this.logoTimer || this.disposed) {
      return;
    }
    this.logoTimer = setTimeout(() => {
      this.logoTimer = undefined;
      if (!this.disposed) {
        this.deps.onLogosLanded();
      }
    }, REPOST_DEBOUNCE_MS);
  }

  /** Fire-and-forget on deactivate: stop pumping, in-flight grim calls just
   *  finish (their cache.save is harmless), the timer is cleared. */
  dispose(): void {
    this.disposed = true;
    this.pending = [];
    if (this.logoTimer) {
      clearTimeout(this.logoTimer);
      this.logoTimer = undefined;
    }
  }
}
