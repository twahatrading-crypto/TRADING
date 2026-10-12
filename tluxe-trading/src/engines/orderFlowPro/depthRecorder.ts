import { HEAT_BUCKET_MS, MAX_HEAT_COLUMNS } from './config';
import { fromTick, toTick } from './classify';
import type { BookSnapshotEvent, DepthLevelEvent, GapEvent, Side } from './types';

/* ============================================================================
 * Historical order-book recorder (browser side, bounded). Records DISPLAYED RESTING size per price level from the
 * IBKR price-level book only - never executed volume. Each heat column holds, per price/side:
 *   sizeMs     - displayed size integrated over the time the book was VALID (-> time-weighted average size),
 *   maxSize    - the largest displayed size seen,
 *   adds / reductions - size increases / decreases observed (a reduction is NOT claimed to be a cancel or a fill),
 * plus the column's validMs. Time when the book was not valid (before the first snapshot, after a gap / reset) is
 * never painted: no depth is invented for it.
 * ========================================================================== */

export interface HeatCell {
  tick: number;
  side: Side;
  sizeMs: number;
  /** Valid-book time this price/side was displayed at all (size > 0). */
  presentMs: number;
  maxSize: number;
  adds: number;
  reductions: number;
}

export interface HeatColumn {
  t: number;
  validMs: number;
  cells: Map<number, HeatCell>;
}

interface LevelMeta {
  since: number;
  adds: number;
  reductions: number;
}

export interface LevelStat {
  tick: number;
  price: number;
  side: Side;
  size: number;
  persistMs: number;
  adds: number;
  reductions: number;
}

export interface StrongLevel extends LevelStat {
  /** Displayed size / median displayed size of the visible book (relative strength, not a probability). */
  relative: number;
  /** Time-weighted average size at this price/side over the lookback (historical intensity). */
  historicalAvg: number;
}

/** One row of the Liquidity Strength table: a level in the CURRENT visible book plus what was observed about it. */
export interface ObservedLevel extends LevelStat {
  relative: number;
  /** Time-weighted average displayed size over the lookback (valid book time only). */
  historicalAvg: number;
  /** Share of the lookback's valid book time this price/side was displayed (0..1). */
  coverage: number;
  strong: boolean;
}

export interface BookCoverage {
  lookbackMs: number;
  /** Valid (recorded, trusted) book time inside the lookback. */
  validMs: number;
  /** validMs / lookbackMs. */
  share: number;
  /** Earliest recorded column (ms) or null. */
  firstRecorded: number | null;
}

/**
 * A run of consecutive heat columns in which one price/side was displayed at >= minRelative x that column's median
 * displayed size. Built only from recorded, valid columns; a column with too little valid time ends the run.
 */
export interface StrongBand {
  tick: number;
  side: Side;
  from: number;
  to: number;
  meanRelative: number;
  maxRelative: number;
  maxAvgSize: number;
}

export type BandTier = 'cyan' | 'green' | 'yellow' | 'white';
/** Relative-strength tiers for drawing observed bands (display classes only, not probabilities). */
export const bandTier = (rel: number): BandTier => (rel >= 6 ? 'white' : rel >= 4.5 ? 'yellow' : rel >= 3.2 ? 'green' : 'cyan');

const cellKey = (tick: number, side: Side) => tick * 2 + (side === 'ASK' ? 1 : 0);

export class DepthRecorder {
  private book: Record<Side, Map<number, number>> = { BID: new Map(), ASK: new Map() };
  private meta = new Map<number, LevelMeta>();
  private columns = new Map<number, HeatColumn>();
  private order: number[] = [];
  private lastT: number | null = null;
  valid = false;
  ignoredWhileInvalid = 0;
  events = 0;

  constructor(readonly tick: number, readonly bucketMs = HEAT_BUCKET_MS, private readonly maxColumns = MAX_HEAT_COLUMNS) {}

  private column(t: number): HeatColumn {
    const ct = Math.floor(t / this.bucketMs) * this.bucketMs;
    let c = this.columns.get(ct);
    if (!c) {
      c = { t: ct, validMs: 0, cells: new Map() };
      this.columns.set(ct, c);
      this.order.push(ct);
      if (this.order.length > 1 && ct < this.order[this.order.length - 2]!) this.order.sort((a, b) => a - b);
      while (this.order.length > this.maxColumns) this.columns.delete(this.order.shift()!);
    }
    return c;
  }

  private cell(col: HeatColumn, tick: number, side: Side): HeatCell {
    const k = cellKey(tick, side);
    let c = col.cells.get(k);
    if (!c) col.cells.set(k, (c = { tick, side, sizeMs: 0, presentMs: 0, maxSize: 0, adds: 0, reductions: 0 }));
    return c;
  }

  /** Integrate the current (valid) book up to `t`, splitting at column boundaries. */
  integrate(t: number) {
    if (this.lastT === null || t <= this.lastT) {
      if (this.lastT === null) this.lastT = t;
      return;
    }
    if (this.valid) {
      let a = this.lastT;
      while (a < t) {
        const colEnd = (Math.floor(a / this.bucketMs) + 1) * this.bucketMs;
        const b = Math.min(t, colEnd);
        const dur = b - a;
        const col = this.column(a);
        col.validMs += dur;
        for (const side of ['BID', 'ASK'] as const) {
          for (const [tick, size] of this.book[side]) {
            const c = this.cell(col, tick, side);
            c.sizeMs += size * dur;
            c.presentMs += dur;
            if (size > c.maxSize) c.maxSize = size;
          }
        }
        a = b;
      }
    }
    this.lastT = t;
  }

  applySnapshot(ev: BookSnapshotEvent) {
    this.integrate(ev.t);
    this.events++;
    // A snapshot of a book that was already valid (the backend's periodic recorded snapshot) keeps the resting
    // history of every level still present; after a gap / reset everything starts fresh.
    const keep = this.valid ? this.meta : new Map<number, LevelMeta>();
    this.book = { BID: new Map(), ASK: new Map() };
    this.meta = new Map();
    const put = (side: Side, p: number, s: number) => {
      const k = toTick(p, this.tick);
      const m = keep.get(cellKey(k, side));
      if (m) this.meta.set(cellKey(k, side), m);
      this.setLevel(side, k, s, ev.t, false);
    };
    for (const [p, s] of ev.bids) if (s > 0) put('BID', p, s);
    for (const [p, s] of ev.asks) if (s > 0) put('ASK', p, s);
    this.valid = true;
    this.lastT = ev.t;
  }

  applyLevel(ev: DepthLevelEvent) {
    if (!this.valid) {
      this.ignoredWhileInvalid++;
      return;
    }
    this.integrate(ev.t);
    this.events++;
    this.setLevel(ev.side, toTick(ev.price, this.tick), ev.size, ev.t, true);
  }

  private setLevel(side: Side, tick: number, size: number, t: number, track: boolean) {
    const key = cellKey(tick, side);
    const old = this.book[side].get(tick) ?? 0;
    if (track && size !== old) {
      const col = this.column(t);
      const c = this.cell(col, tick, side);
      let m = this.meta.get(key);
      if (!m) this.meta.set(key, (m = { since: t, adds: 0, reductions: 0 }));
      if (size > old) {
        c.adds += size - old;
        m.adds += size - old;
      } else {
        c.reductions += old - size;
        m.reductions += old - size;
      }
      if (size > c.maxSize) c.maxSize = size;
    }
    if (size <= 0) {
      this.book[side].delete(tick);
      this.meta.delete(key);
    } else {
      this.book[side].set(tick, size);
      if (!this.meta.has(key)) this.meta.set(key, { since: t, adds: 0, reductions: 0 });
    }
  }

  /** Book can no longer be trusted (disconnect / IBKR reset / sequence gap / stale): stop painting until a snapshot. */
  applyGap(ev: GapEvent) {
    this.integrate(ev.from);
    this.valid = false;
    this.book = { BID: new Map(), ASK: new Map() };
    this.meta.clear();
    this.lastT = Math.max(ev.to, this.lastT ?? ev.to);
  }

  currentBook(): { bids: Array<[number, number]>; asks: Array<[number, number]> } {
    if (!this.valid) return { bids: [], asks: [] };
    const bids = [...this.book.BID].sort((a, b) => b[0] - a[0]).map(([k, s]) => [fromTick(k, this.tick), s] as [number, number]);
    const asks = [...this.book.ASK].sort((a, b) => a[0] - b[0]).map(([k, s]) => [fromTick(k, this.tick), s] as [number, number]);
    return { bids, asks };
  }

  levelStats(now: number): LevelStat[] {
    if (!this.valid) return [];
    const out: LevelStat[] = [];
    for (const side of ['BID', 'ASK'] as const)
      for (const [tick, size] of this.book[side]) {
        const m = this.meta.get(cellKey(tick, side));
        out.push({ tick, price: fromTick(tick, this.tick), side, size, persistMs: m ? Math.max(0, now - m.since) : 0, adds: m?.adds ?? 0, reductions: m?.reductions ?? 0 });
      }
    return out;
  }

  /** Time-weighted average displayed size at one price/side over [from, to] (valid time only). */
  historicalAvg(tick: number, side: Side, from: number, to: number): number {
    let sizeMs = 0;
    let validMs = 0;
    const k = cellKey(tick, side);
    for (const t of this.order) {
      if (t + this.bucketMs <= from || t > to) continue;
      const c = this.columns.get(t)!;
      validMs += c.validMs;
      sizeMs += c.cells.get(k)?.sizeMs ?? 0;
    }
    return validMs > 0 ? sizeMs / validMs : 0;
  }

  /**
   * Strong resting liquidity NOW: displayed size >= minRelative x the visible book's median AND resting for at least
   * minPersistMs. Evidence of displayed size only (it may be pulled at any time; never called "real" or "iceberg").
   */
  strongLevels(now: number, opts: { minRelative: number; minPersistMs: number; lookbackMs: number }): StrongLevel[] {
    const stats = this.levelStats(now);
    if (stats.length < 3) return [];
    const sizes = stats.map((s) => s.size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)]!;
    if (median <= 0) return [];
    return stats
      .filter((s) => s.size / median >= opts.minRelative && s.persistMs >= opts.minPersistMs)
      .map((s) => ({ ...s, relative: s.size / median, historicalAvg: this.historicalAvg(s.tick, s.side, now - opts.lookbackMs, now) }))
      .sort((a, b) => b.relative - a.relative);
  }

  /** Valid recorded book time inside [now - lookbackMs, now]. */
  coverage(now: number, lookbackMs: number): BookCoverage {
    let validMs = 0;
    for (const t of this.order) if (t + this.bucketMs > now - lookbackMs && t <= now) validMs += this.columns.get(t)!.validMs;
    return { lookbackMs, validMs, share: Math.min(1, validMs / lookbackMs), firstRecorded: this.order.length ? this.order[0]! : null };
  }

  /** Every level of the current book with its observed persistence, relative size, 30-min average and coverage. */
  observedLevels(now: number, opts: { minRelative: number; minPersistMs: number; lookbackMs: number }): ObservedLevel[] {
    const stats = this.levelStats(now);
    if (!stats.length) return [];
    const sizes = stats.map((s) => s.size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)]!;
    const from = now - opts.lookbackMs;
    return stats
      .map((s) => {
        let validMs = 0;
        let presentMs = 0;
        let sizeMs = 0;
        const k = cellKey(s.tick, s.side);
        for (const t of this.order) {
          if (t + this.bucketMs <= from || t > now) continue;
          const c = this.columns.get(t)!;
          validMs += c.validMs;
          const cell = c.cells.get(k);
          if (cell) {
            presentMs += cell.presentMs;
            sizeMs += cell.sizeMs;
          }
        }
        const relative = median > 0 ? s.size / median : 0;
        return {
          ...s,
          relative,
          historicalAvg: validMs > 0 ? sizeMs / validMs : 0,
          coverage: validMs > 0 ? Math.min(1, presentMs / validMs) : 0,
          strong: stats.length >= 3 && relative >= opts.minRelative && s.persistMs >= opts.minPersistMs,
        };
      })
      .sort((a, b) => b.relative - a.relative);
  }

  /** Observed strong bands inside [from, to] (see StrongBand). */
  strongBands(from: number, to: number, opts: { minRelative: number; minColumns: number; minValidShare?: number }): StrongBand[] {
    const out: StrongBand[] = [];
    type Run = StrongBand & { n: number; sumRel: number };
    const active = new Map<number, Run>();
    const close = (k: number) => {
      const r = active.get(k)!;
      active.delete(k);
      if (r.n >= opts.minColumns) out.push({ tick: r.tick, side: r.side, from: r.from, to: r.to, meanRelative: r.sumRel / r.n, maxRelative: r.maxRelative, maxAvgSize: r.maxAvgSize });
    };
    const minValid = this.bucketMs * (opts.minValidShare ?? 0.5);
    let prev: number | null = null;
    for (const col of this.columnsIn(from, to)) {
      // a missing column (nothing recorded: gap / before the first snapshot) ends every run
      if (prev !== null && col.t !== prev + this.bucketMs) for (const k of [...active.keys()]) close(k);
      prev = col.t;
      if (col.validMs < minValid) {
        for (const k of [...active.keys()]) close(k);
        continue;
      }
      const avgs: number[] = [];
      for (const c of col.cells.values()) if (c.presentMs > 0) avgs.push(c.sizeMs / col.validMs);
      if (avgs.length < 3) {
        for (const k of [...active.keys()]) close(k);
        continue;
      }
      avgs.sort((a, b) => a - b);
      const median = avgs[Math.floor(avgs.length / 2)]!;
      const seen = new Set<number>();
      for (const [k, c] of col.cells) {
        const avg = c.sizeMs / col.validMs;
        const rel = median > 0 ? avg / median : 0;
        if (rel < opts.minRelative) continue;
        seen.add(k);
        let r = active.get(k);
        if (!r) active.set(k, (r = { tick: c.tick, side: c.side, from: col.t, to: col.t, meanRelative: 0, maxRelative: 0, maxAvgSize: 0, n: 0, sumRel: 0 }));
        r.to = col.t + this.bucketMs;
        r.n++;
        r.sumRel += rel;
        r.maxRelative = Math.max(r.maxRelative, rel);
        r.maxAvgSize = Math.max(r.maxAvgSize, avg);
      }
      for (const k of [...active.keys()]) if (!seen.has(k)) close(k);
    }
    for (const k of [...active.keys()]) close(k);
    return out;
  }

  columnsIn(from: number, to: number): HeatColumn[] {
    const out: HeatColumn[] = [];
    for (const t of this.order) if (t + this.bucketMs > from && t <= to) out.push(this.columns.get(t)!);
    return out;
  }

  get columnCount() {
    return this.order.length;
  }

  clear() {
    this.book = { BID: new Map(), ASK: new Map() };
    this.meta.clear();
    this.columns.clear();
    this.order = [];
    this.lastT = null;
    this.valid = false;
    this.ignoredWhileInvalid = 0;
    this.events = 0;
  }
}
