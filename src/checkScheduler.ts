// Coalesces "ask grim for update verdicts" requests into ONE `grim status
// --check` round per quiet window. Pure scheduling (no vscode, no grim): the
// round itself and the enabled gate are injected, so this is unit-testable with
// a 10ms window instead of the real one.
//
// It replaces a once-a-day throttle. That throttle was cheap for grim and
// expensive for the user: `update_available` exists ONLY in a checked round, so
// an artifact declared after the day's round carried no update information at
// all — its row said nothing, for up to 24h, however often the view refreshed.
// Every refresh now asks; the debounce is what keeps "every refresh" from
// meaning "every refresh spawns a network round". A burst of five lock writes
// lands one check, a few seconds after the last of them.

/** Quiet window before a requested check actually runs. Long enough that an
 *  install → lock-write → watcher-event → completion-refresh cascade collapses
 *  into one round; short enough that the number appears while the user is still
 *  looking at what they just did. */
export const CHECK_DEBOUNCE_MS = 5000;

export class CheckScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    /** Runs one checked round. Never rejects into the timer — the caller logs. */
    private readonly run: () => Promise<void>,
    private readonly delayMs: number = CHECK_DEBOUNCE_MS,
    /** A no-op while this returns false (grimoire.checkArtifactUpdates, trust). */
    private readonly enabled: () => boolean = () => true,
  ) {}

  /** Asks for a check. Restarts the window rather than queueing: during a burst
   *  the LAST request is the one whose state is worth checking, and the ones
   *  before it would each have spawned a round that the next write invalidates. */
  request(): void {
    if (this.disposed || !this.enabled()) {
      return;
    }
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.disposed) {
        void this.run();
      }
    }, this.delayMs);
  }

  /** Runs one now (the explicit command), dropping any pending window — the
   *  user asking IS the trigger, and a scheduled round behind it would be a
   *  second identical network pass. Ignores the enabled gate for the same
   *  reason: an explicit request outranks the setting that governs automatic
   *  ones. */
  async now(): Promise<void> {
    this.clear();
    if (!this.disposed) {
      await this.run();
    }
  }

  /** True while a window is open — test seam and diagnostics. */
  get pending(): boolean {
    return this.timer !== undefined;
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}
