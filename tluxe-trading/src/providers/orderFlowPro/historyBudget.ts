/* ============================================================================
 * Order Flow Pro: ONE per-page budget for every recorded-depth read (/api/ibkr/heatmap): the heatmap's on-demand
 * history, the one-time liquidity-history read and replay. At most HISTORY_REQUESTS_PER_MIN in any 60 s window,
 * GC + SI together. Nothing here polls: `tryTake` never waits, `acquire` waits with a single timer for the next free
 * slot (bounded) and then takes it.
 * ========================================================================== */

export const HISTORY_REQUESTS_PER_MIN = 10;
const WINDOW_MS = 60_000;

export class HistoryBudget {
  private stamps: number[] = [];

  constructor(
    readonly limit = HISTORY_REQUESTS_PER_MIN,
    private readonly clock: () => number = () => Date.now(),
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private prune(now: number) {
    while (this.stamps.length && now - this.stamps[0]! >= WINDOW_MS) this.stamps.shift();
  }

  used(): number {
    this.prune(this.clock());
    return this.stamps.length;
  }

  /** Take a slot now if one is free (never waits). */
  tryTake(): boolean {
    const now = this.clock();
    this.prune(now);
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(now);
    return true;
  }

  /** Milliseconds until a slot frees (0 when one is free now; Infinity when none can ever free). */
  nextFreeInMs(): number {
    const now = this.clock();
    this.prune(now);
    if (this.stamps.length < this.limit) return 0;
    if (!this.stamps.length) return Infinity;
    return Math.max(0, this.stamps[0]! + WINDOW_MS - now);
  }

  /** Wait (single timer per attempt, at most `maxWaitMs` in total) for a slot and take it; false if it timed out. */
  async acquire(maxWaitMs = 2 * WINDOW_MS): Promise<boolean> {
    let waited = 0;
    for (;;) {
      if (this.tryTake()) return true;
      const ms = Math.max(50, this.nextFreeInMs());
      if (!Number.isFinite(ms) || waited + ms > maxWaitMs) return false;
      waited += ms;
      await this.wait(ms);
    }
  }

  /** Test hook. */
  reset() {
    this.stamps = [];
  }
}

/** The page-wide budget (one browser page = one budget across GC and SI). */
export const historyBudget = new HistoryBudget();
