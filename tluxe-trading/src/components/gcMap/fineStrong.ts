import { analyzeMap, isStrong, midOf, type MapColumn, type Side, type StrongParams } from './liquidityMap';

/* ============================================================================
 * GC Liquidity Map - STRONG LIQUIDITY PERSISTENCE FROM THE FINEST RECORDED DEPTH (250 ms), independent of the chart.
 *
 * Strong qualification, age, run start and run end are read ONLY from the 250 ms recorded IBKR depth columns, with
 * the existing analysis (analyzeMap: runs, FEED_GAP / OUT_OF_VISIBLE_BOOK / PULLED / TRADED ends) and the existing
 * rule (isStrong: size, relative, persistence, distance - same thresholds). The chart's bucket, timeframe, zoom or
 * window never enter here, so they can never inflate persistence (a 300 s chart bucket is not 300 s of presence).
 *
 * Incremental and exact: each update analyses only the columns from the latest ANCHOR column on; a run that is open
 * at the anchor keeps its real start (and qualification time) carried from the previous analysis, so every observed
 * time equals what one analysis of all retained columns gives (proved in the tests). Missing observations are never
 * bridged: a run ends where the analysis ends it. A run already present in the first analysed column has an unknown
 * earlier start: its age is a LOWER BOUND (shown as >=) and its qualification is never back-dated before it.
 * ========================================================================== */

export const FINE_BUCKET_MS = 250;
/** Anchor spacing: each update re-analyses at most ~2 x this much 250 ms data. */
export const FINE_STEP_MS = 60_000;
/** 250 ms history kept for Strong Only bands / full re-analysis (older strong intervals are kept, columns are not). */
export const FINE_RETENTION_MS = 20 * 60_000;
/** The 250 ms series is "current" only when its last recorded-valid time is this close to now. */
export const FINE_STALE_MS = 6_000;

export interface FineLevel {
  side: Side;
  tick: number;
  /** Displayed size / relative of the level in the latest 250 ms bucket. */
  size: number;
  relative: number;
  /** Continuous observed time at 250 ms resolution up to the end of the latest bucket. */
  observedMs: number;
  runStart: number;
  /** End of the 250 ms bucket in which the run first met every Strong threshold (null = has not). Never back-dated. */
  qualifiedAt: number | null;
  /** The run was already present in the first analysed bucket: the real start (age) may be earlier. */
  lowerBound: boolean;
}
/** A STRONG LIQUIDITY NOW row: size / relative from the live book, persistence from the 250 ms series. */
export interface StrongNowRow {
  side: Side;
  tick: number;
  size: number;
  relative: number;
  /** Continuous observed time at 250 ms resolution. */
  observedMs: number;
  runStart: number | null;
  qualifiedAt: number | null;
  lowerBound: boolean;
}
export interface StrongInterval {
  side: Side;
  tick: number;
  /** Qualification time .. end of the run (or the latest bucket while it continues). */
  from: number;
  to: number;
}
interface RunState {
  start: number;
  qualifiedAt: number | null;
  lowerBound: boolean;
}
interface Snapshot {
  t: number;
  runs: Map<string, RunState>;
}

const vEnd = (c: MapColumn) => (c.valid.length ? c.valid[c.valid.length - 1]! : c.t + c.w);
const keyOf = (side: Side, tick: number) => `${side}${tick}`;

/**
 * One analysis of `cols` (250 ms, from the anchor) with the runs carried into its first column. Pure.
 * Returns the levels of the last column, the strong intervals of every run, and the run state at the requested
 * snapshot columns.
 */
export function analyzeFine(cols: readonly MapColumn[], p: StrongParams, carry: ReadonlyMap<string, RunState> | null, snapAt: ReadonlySet<number> = new Set()) {
  const r = analyzeMap(cols);
  const mids = cols.map(midOf);
  const open = new Map<string, RunState>();
  const intervals: StrongInterval[] = [];
  const snaps: Snapshot[] = [];
  const last: FineLevel[] = [];
  const lastC = cols.length - 1;
  let colRuns: [string, RunState][] = [];
  let curC = -1;
  const flush = () => {
    if (curC >= 0 && snapAt.has(curC)) snaps.push({ t: cols[curC]!.t, runs: new Map(colRuns.map(([k, s]) => [k, { ...s }])) });
    colRuns = [];
  };
  for (const cell of r.cells) {
    if (cell.c !== curC) {
      flush();
      curC = cell.c;
    }
    const col = cols[cell.c]!;
    const e = vEnd(col);
    const k = keyOf(cell.side, cell.tick);
    let s = open.get(k);
    if (!s) {
      const engineStart = e - cell.observedMs;
      const carried = cell.c === 0 ? carry?.get(k) : undefined;
      s = carried ? { ...carried } : { start: engineStart, qualifiedAt: null, lowerBound: cell.c === 0 && carry === null };
      open.set(k, s);
    }
    const observedMs = e - s.start;
    if (s.qualifiedAt === null && isStrong({ size: cell.size, relative: cell.relative, observedMs, tick: cell.tick }, mids[cell.c] ?? null, p)) s.qualifiedAt = e;
    colRuns.push([k, s]);
    if (cell.c === lastC) last.push({ side: cell.side, tick: cell.tick, size: cell.size, relative: cell.relative, observedMs, runStart: s.start, qualifiedAt: s.qualifiedAt, lowerBound: s.lowerBound });
    if (cell.end || cell.c === lastC) {
      if (s.qualifiedAt !== null) intervals.push({ side: cell.side, tick: cell.tick, from: s.qualifiedAt, to: e });
      if (cell.end) open.delete(k);
    }
  }
  flush();
  return { last, intervals, snaps, lastEnd: cols.length ? vEnd(cols[lastC]!) : null };
}

/**
 * Keeps the 250 ms Strong state current from the page's 250 ms recorded-depth columns (the existing store, same
 * endpoint). Stateful only to stay cheap: what it reports always equals one analysis of all retained columns.
 */
export class FineStrong {
  private snaps: Snapshot[] = [];
  private params: StrongParams | null = null;
  private store = new Map<string, StrongInterval>();
  levels = new Map<string, FineLevel>();
  lastEnd: number | null = null;
  /** First 250 ms bucket analysed (nothing about Strong is known before it). */
  since: number | null = null;

  /** `cols`: the 250 ms columns (sorted). Returns the oldest column time still needed (older ones can be dropped). */
  update(cols: readonly MapColumn[], p: StrongParams): number | null {
    if (!cols.length) return null;
    const paramsChanged = !this.params || (Object.keys(p) as (keyof StrongParams)[]).some((k) => p[k] !== this.params![k]);
    this.params = { ...p };
    let a = -1;
    let carry: Map<string, RunState> | null = null;
    if (!paramsChanged) {
      // the latest snapshot whose column is still here
      for (let i = this.snaps.length - 1; i >= 0 && a < 0; i--) {
        const idx = indexAt(cols, this.snaps[i]!.t);
        if (idx >= 0) {
          a = idx;
          carry = this.snaps[i]!.runs;
          this.snaps.length = i + 1;
        }
      }
    }
    if (a < 0) {
      // Full analysis of what is retained: the oldest snapshot carries the run starts (thresholds may have changed,
      // so qualification before it is unknown and re-derived from here - never back-dated).
      const base = this.snaps.find((s) => indexAt(cols, s.t) >= 0);
      a = base ? indexAt(cols, base.t) : 0;
      carry = base ? new Map([...base.runs].map(([k, s]) => [k, { start: s.start, qualifiedAt: null, lowerBound: s.lowerBound }])) : null;
      this.snaps = [];
      this.store.clear();
      if (this.since === null || !base) this.since = cols[a]!.t;
    }
    const win = cols.slice(a);
    const lastT = win[win.length - 1]!.t;
    // snapshot columns: every FINE_STEP_MS after the anchor, keeping the newest one at least FINE_STEP_MS behind now
    const want = new Set<number>();
    const anchorT = win[0]!.t;
    for (let i = 1; i < win.length; i++) {
      const t = win[i]!.t;
      if (t - anchorT >= FINE_STEP_MS && Math.floor((t - anchorT) / FINE_STEP_MS) !== Math.floor((win[i - 1]!.t - anchorT) / FINE_STEP_MS) && lastT - t >= FINE_STEP_MS) want.add(i);
    }
    // the anchor's own run state is taken from this analysis (starts carried in, or unknown = lower bound)
    if (!this.snaps.length || this.snaps[this.snaps.length - 1]!.t !== anchorT) want.add(0);
    const out = analyzeFine(win, p, carry, want);
    this.snaps.push(...out.snaps);
    for (const iv of out.intervals) this.store.set(`${iv.side}${iv.tick}@${iv.from}`, iv);
    this.levels = new Map(out.last.map((l) => [keyOf(l.side, l.tick), l]));
    this.lastEnd = out.lastEnd;
    // retention: drop snapshots (and so columns) older than FINE_RETENTION_MS, keep at least one
    const cut = (out.lastEnd ?? lastT) - FINE_RETENTION_MS;
    while (this.snaps.length > 1 && this.snaps[1]!.t <= cut) this.snaps.shift();
    for (const [k, iv] of this.store) if (iv.to < (out.lastEnd ?? lastT) - 86_400_000) this.store.delete(k);
    return this.snaps[0]?.t ?? null;
  }

  /** Strong intervals (qualified .. run end) of every run analysed so far. */
  intervals(): StrongInterval[] {
    return [...this.store.values()];
  }
  /** The 250 ms series reaches close enough to `now` to judge the current book. */
  current(now: number): boolean {
    return this.lastEnd !== null && now - this.lastEnd <= FINE_STALE_MS;
  }
}

function indexAt(cols: readonly MapColumn[], t: number): number {
  let lo = 0;
  let hi = cols.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const x = cols[m]!.t;
    if (x === t) return m;
    if (x < t) lo = m + 1;
    else hi = m - 1;
  }
  return -1;
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * STRONG LIQUIDITY NOW (pure): levels of the live visible book with size >= minSize, relative (to the other rows of
 * that side) >= minRelative, within maxDistance of the book mid - same rules and thresholds as before - and continuous
 * persistence >= minPersist measured ONLY on the 250 ms series (`levels`). No chart data is an input. Asks then bids,
 * highest price first.
 */
export function strongNowRows(book: { bids: readonly { tick: number; size: number }[]; asks: readonly { tick: number; size: number }[] }, levels: ReadonlyMap<string, FineLevel>, p: StrongParams): { asks: StrongNowRow[]; bids: StrongNowRow[] } {
  const best = book.bids.length && book.asks.length ? (Math.max(...book.bids.map((r) => r.tick)) + Math.min(...book.asks.map((r) => r.tick))) / 2 : null;
  const side = (rows: readonly { tick: number; size: number }[], sd: Side) =>
    rows
      .map((r): StrongNowRow => {
        const rel = r.size / Math.max(1e-9, median(rows.filter((x) => x !== r).map((x) => x.size)));
        const f = levels.get(keyOf(sd, r.tick));
        return { side: sd, tick: r.tick, size: r.size, relative: rel, observedMs: f?.observedMs ?? 0, runStart: f?.runStart ?? null, qualifiedAt: f?.qualifiedAt ?? null, lowerBound: f?.lowerBound ?? false };
      })
      .filter((x) => x.size >= p.minSize && x.relative >= p.minRelative && x.observedMs >= p.minPersistMs && (best === null || Math.abs(x.tick - best) <= p.maxDistanceTicks))
      .sort((a, b) => b.tick - a.tick);
  return { asks: side(book.asks, 'ASK'), bids: side(book.bids, 'BID') };
}
