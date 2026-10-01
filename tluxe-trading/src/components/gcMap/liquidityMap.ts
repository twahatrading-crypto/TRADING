/* ============================================================================
 * GC Liquidity Map - pure, read-only analysis of RECORDED IBKR price-level depth (the existing /api/ibkr/heatmap
 * matrix: per time bucket, the time-weighted displayed size per exact price over the bucket's recorded-valid time).
 *
 * Nothing is created: a cell exists only where IBKR displayed size at that price in that bucket; a bucket without a
 * recorded-valid interval is a DEPTH GAP (never filled from a neighbour); no interpolation across time or price; the
 * newest value never rewrites an older bucket. IBKR depth is the VISIBLE aggregated price-level book (top rows per
 * side), not the full COMEX book and not market-by-order.
 *
 * Per cell:   size (displayed, time-weighted over the bucket), side (BID / ASK as recorded), relative = size / median
 *             of the other displayed levels of the same side in that bucket, observedMs = continuous observed time of
 *             that price on that side up to the end of the bucket (restarts after a gap or an absence).
 * Run end:    the reason a continuously observed level stopped being drawn:
 *   FEED_GAP             the next bucket has no recorded-valid depth (or a hole inside the bucket)
 *   OUT_OF_VISIBLE_BOOK  the price is outside the next bucket's displayed range - unknown, never assumed cancelled
 *   TRADED               still inside the displayed range and gone, with Databento executions at that price around the
 *                        removal of >= TRADED_SHARE of its last size
 *   PULLED_CONFIRMED     inside the displayed range and gone without enough executions at the price
 *   UNDETERMINED         buckets coarser than CLASSIFY_MAX_BUCKET_MS merge several books - the reason is not claimed
 * ========================================================================== */

export type Side = 'BID' | 'ASK';
export type RunEnd = 'FEED_GAP' | 'OUT_OF_VISIBLE_BOOK' | 'TRADED' | 'PULLED_CONFIRMED' | 'UNDETERMINED';

export interface MapColumn {
  t: number;
  w: number;
  /** Exact recorded-valid intervals [from, to) (flattened pairs). */
  valid: Float64Array;
  bidTicks: Int32Array;
  bidSizes: Float64Array;
  askTicks: Int32Array;
  askSizes: Float64Array;
}
export interface Print {
  t: number;
  tick: number;
  size: number;
}
export interface MapCell {
  /** Index of the column. */
  c: number;
  side: Side;
  tick: number;
  size: number;
  relative: number;
  /** Continuous observed time of this price on this side up to the end of this bucket (ms). */
  observedMs: number;
  /** Set on the last cell of a continuous run (the band ends here); null while the run continues. */
  end: RunEnd | null;
}
export interface MapResult {
  cells: MapCell[];
  /** Recorded-valid intervals of the analysed columns, merged; everything else in [from, to) is a depth gap. */
  covered: [number, number][];
  /** Reference size for intensity (robust high percentile of all displayed sizes). */
  refSize: number;
}

export const CLASSIFY_MAX_BUCKET_MS = 1000;
export const TRADE_TOLERANCE_MS = 1000;
export const TRADED_SHARE = 0.5;
/** Intensity reference: this percentile of all displayed sizes in the analysed range maps to full intensity. */
export const REF_PERCENTILE = 0.99;

const median = (v: number[]): number => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const vStart = (c: MapColumn) => (c.valid.length ? c.valid[0]! : c.t);
const vEnd = (c: MapColumn) => (c.valid.length ? c.valid[c.valid.length - 1]! : c.t + c.w);
const holeInside = (c: MapColumn) => {
  for (let i = 2; i < c.valid.length; i += 2) if (c.valid[i]! - c.valid[i - 1]! > 1) return true;
  return false;
};

/** Executed volume at exactly this price in [a, b] (prints sorted by time). */
export function volumeAt(prints: readonly Print[], tick: number, a: number, b: number): number {
  let lo = 0;
  let hi = prints.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (prints[m]!.t < a) lo = m + 1;
    else hi = m;
  }
  let v = 0;
  for (let i = lo; i < prints.length && prints[i]!.t <= b; i++) if (prints[i]!.tick === tick) v += prints[i]!.size;
  return v;
}

function sideCells(ticks: Int32Array, sizes: Float64Array): { tick: number; size: number; relative: number }[] {
  const out: { tick: number; size: number; relative: number }[] = [];
  for (let i = 0; i < ticks.length; i++) {
    const s = sizes[i]!;
    if (!(s > 0)) continue;
    const others: number[] = [];
    for (let k = 0; k < ticks.length; k++) if (k !== i && sizes[k]! > 0) others.push(sizes[k]!);
    const m = median(others);
    out.push({ tick: ticks[i]!, size: s, relative: m > 0 ? s / m : 1 });
  }
  return out;
}
const range = (ticks: Int32Array, sizes: Float64Array): [number, number] | null => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < ticks.length; i++) {
    if (!(sizes[i]! > 0)) continue;
    lo = Math.min(lo, ticks[i]!);
    hi = Math.max(hi, ticks[i]!);
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
};

/** The price is inside the displayed range of its side in this column (bid: >= deepest bid; ask: <= deepest ask). */
export function observableIn(c: MapColumn, side: Side, tick: number): boolean {
  const r = side === 'BID' ? range(c.bidTicks, c.bidSizes) : range(c.askTicks, c.askSizes);
  if (!r) return false;
  return side === 'BID' ? tick >= r[0] : tick <= r[1];
}

/**
 * Analyse recorded columns (sorted by time, one bucket width). Causal per cell: a cell's size / relative / observed
 * time depend only on its own and earlier buckets; only the END marker of a run depends on the following bucket.
 */
export function analyzeMap(cols: readonly MapColumn[], prints: readonly Print[] = []): MapResult {
  const cells: MapCell[] = [];
  const covered: [number, number][] = [];
  const all: number[] = [];
  // open run per side:tick -> index of its last cell + run start
  let open = new Map<string, { cell: number; start: number }>();
  let prev: MapColumn | null = null;
  const endRuns = (reason: (key: string, cell: MapCell) => RunEnd) => {
    for (const [k, r] of open) cells[r.cell]!.end = reason(k, cells[r.cell]!);
    open = new Map();
  };
  for (let ci = 0; ci < cols.length; ci++) {
    const c = cols[ci]!;
    if (!c.valid.length) continue;
    const s = vStart(c);
    const e = vEnd(c);
    const last = covered[covered.length - 1];
    if (last && s - last[1] <= 1) last[1] = Math.max(last[1], e);
    else covered.push([s, e]);
    if (prev && s - vEnd(prev) > 1) endRuns(() => 'FEED_GAP');
    const coarse = c.w > CLASSIFY_MAX_BUCKET_MS;
    const here = new Map<string, { side: Side; tick: number; size: number; relative: number }>();
    for (const x of sideCells(c.bidTicks, c.bidSizes)) here.set(`B${x.tick}`, { side: 'BID', ...x });
    for (const x of sideCells(c.askTicks, c.askSizes)) here.set(`A${x.tick}`, { side: 'ASK', ...x });
    // Runs that do not continue into this bucket end at the previous one.
    for (const [k, r] of [...open]) {
      if (here.has(k)) continue;
      const cell = cells[r.cell]!;
      if (coarse) cell.end = 'UNDETERMINED';
      else if (!observableIn(c, cell.side, cell.tick)) cell.end = 'OUT_OF_VISIBLE_BOOK';
      else {
        const pc = cols[cell.c]!;
        const vol = volumeAt(prints, cell.tick, pc.t - TRADE_TOLERANCE_MS, e + TRADE_TOLERANCE_MS);
        cell.end = vol > 0 && vol >= TRADED_SHARE * cell.size ? 'TRADED' : 'PULLED_CONFIRMED';
      }
      open.delete(k);
    }
    for (const [k, x] of here) {
      const r = open.get(k);
      const start = r ? r.start : s;
      cells.push({ c: ci, side: x.side, tick: x.tick, size: x.size, relative: x.relative, observedMs: e - start, end: null });
      open.set(k, { cell: cells.length - 1, start });
      all.push(x.size);
    }
    if (holeInside(c)) endRuns(() => 'FEED_GAP');
    prev = c;
  }
  all.sort((a, b) => a - b);
  const refSize = all.length ? all[Math.min(all.length - 1, Math.floor(REF_PERCENTILE * (all.length - 1)))]! : 0;
  return { cells, covered, refSize };
}

/** Curve exponent at Intensity 1.0: ordinary depth stays faint, only large displayed size turns hot. */
export const INTENSITY_EXPONENT = 1.6;
/** Intensity 0..1 of a displayed size against the reference; `gain` is the Intensity control (1 = default). */
export function intensityOf(size: number, refSize: number, gain = 1): number {
  if (!(size > 0) || !(refSize > 0)) return 0;
  return Math.max(0, Math.min(1, Math.pow(size / refSize, INTENSITY_EXPONENT / Math.max(0.25, gain))));
}

/**
 * Strong Only, per continuous run: a run is shown from the first bucket at which it qualifies until it ends (never
 * before - not back-dated). Returns the set of qualifying cell indexes (cells are in column order).
 */
export function strongRunCells(cells: readonly MapCell[], mids: readonly (number | null)[], p: StrongParams): Set<number> {
  const out = new Set<number>();
  const on = new Set<string>();
  cells.forEach((c, i) => {
    const k = `${c.side}${c.tick}`;
    if (!on.has(k) && isStrong(c, mids[c.c] ?? null, p)) on.add(k);
    if (on.has(k)) out.add(i);
    if (c.end) on.delete(k);
  });
  return out;
}

/** Heat colour stops by intensity (DISPLAYED LIQUIDITY INTENSITY only - never side, direction or signal). */
export const HEAT_STOPS: readonly [number, [number, number, number]][] = [
  [0, [30, 64, 175]],
  [0.25, [37, 99, 235]],
  [0.45, [6, 182, 212]],
  [0.65, [250, 204, 21]],
  [0.82, [249, 115, 22]],
  [0.93, [239, 68, 68]],
  [1, [255, 245, 235]],
];
export function heatColor(i: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, i));
  for (let k = 1; k < HEAT_STOPS.length; k++) {
    const [b, cb] = HEAT_STOPS[k]!;
    if (x <= b) {
      const [a, ca] = HEAT_STOPS[k - 1]!;
      const f = (x - a) / (b - a || 1);
      return [0, 1, 2].map((j) => Math.round(ca[j]! + (cb[j]! - ca[j]!) * f)) as [number, number, number];
    }
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1]![1];
}

export interface StrongParams {
  minSize: number;
  minRelative: number;
  minPersistMs: number;
  /** Max distance from the mid (ticks). */
  maxDistanceTicks: number;
}
export const DEFAULT_STRONG: Readonly<StrongParams> = Object.freeze({ minSize: 10, minRelative: 2.5, minPersistMs: 10_000, maxDistanceTicks: 50 });

/** A cell qualifies as strong (Strong Only / labels / Strong Liquidity Now): every threshold holds. */
export function isStrong(cell: Pick<MapCell, 'size' | 'relative' | 'observedMs' | 'tick'>, midTick: number | null, p: StrongParams): boolean {
  return cell.size >= p.minSize && cell.relative >= p.minRelative && cell.observedMs >= p.minPersistMs && (midTick === null || Math.abs(cell.tick - midTick) <= p.maxDistanceTicks);
}

/** Mid of the best bid / ask of a column (ticks), null when a side is empty. */
export function midOf(c: MapColumn): number | null {
  const b = range(c.bidTicks, c.bidSizes);
  const a = range(c.askTicks, c.askSizes);
  return b && a ? (b[1] + a[0]) / 2 : null;
}
