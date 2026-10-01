import type { ChartNavigable } from '../chart/ChartStage';
import type { MapCell, MapColumn, MapResult, StrongParams } from './liquidityMap';
import type { StrongInterval, StrongNowRow } from './fineStrong';
import { SESSION_MIN_SPAN_MS } from './viewRange';

/* ============================================================================
 * GC Liquidity Map canvas (this page only). Draws, from data it is handed and never alters:
 *   - recorded IBKR liquidity as 1-tick rectangles: width = the bucket's recorded-valid TIME, colour = DISPLAYED SIZE
 *     intensity (never a side / direction / signal), only inside recorded-valid time; depth gaps are hatched;
 *   - real Databento candles (narrow), the current price line + tag;
 *   - a CURRENT DEPTH profile column from the live visible IBKR book only (bid / ask distinct);
 *   - the qualified STRONG LIQUIDITY NOW levels (handed in by the page, never computed here): their recorded band is
 *     outlined back to where its run started and labelled at the live edge.
 * The visible time window follows the page's choice (LIVE SESSION = the current continuous recorded-depth session,
 * or a fixed span); wheel / drag change the view only.
 * ========================================================================== */

export interface MapCandle {
  /** Open time (ms). */
  t: number;
  ms: number;
  o: number;
  h: number;
  l: number;
  c: number;
}
export interface DepthRow {
  tick: number;
  size: number;
}
export interface MapFrame {
  cols: readonly MapColumn[];
  result: MapResult | null;
  candles: readonly MapCandle[];
  /** Current visible IBKR book (null = not LIVE / no valid book). */
  book: { bids: DepthRow[]; asks: DepthRow[] } | null;
  /** IBKR lastUpdate of that book (ms) - diagnostics only. */
  bookUpdateMs?: number | null;
  lastPriceTick: number | null;
  showCandles: boolean;
  showHeat: boolean;
  showDepth: boolean;
  strongOnly: boolean;
  showLabels: boolean;
  gain: number;
  strong: StrongParams;
  /** End of confirmed recorded coverage when depth is not live (the NO DEPTH DATA region starts there). */
  depthLive: boolean;
  /** STRONG LIQUIDITY NOW rows exactly as the page lists them (display only: outlined + labelled, never re-scored). */
  strongNow?: readonly StrongNowRow[];
  /** Strong intervals (qualified .. run end) from the 250 ms series: Strong Only shows a chart cell only if its time
   *  overlaps one of its own price / side - the chart bucket never decides qualification. */
  strongIntervals?: readonly StrongInterval[];
  /** The recorded depth of a newly chosen window has not arrived yet: nothing is claimed missing while loading. */
  loading?: boolean;
  version: number;
}
export type { StrongNowRow };
/** What the visible time window follows: the current depth session (start grows with it) or a fixed span to now. */
export type ViewRange = { kind: 'session'; start: number } | { kind: 'span'; ms: number };
export interface Viewport {
  t0: number;
  t1: number;
  p0: number;
  p1: number;
}
export interface HoverInfo {
  x: number;
  y: number;
  cell: MapCell;
  col: MapColumn;
}

export const AXIS_RIGHT = 66;
export const AXIS_BOTTOM = 22;
/** CURRENT DEPTH column share of the drawing width (the time chart keeps ~87 %). */
export const PROFILE_SHARE = 0.13;
export const DEFAULT_SPAN_MS = 3600_000;
const DEFAULT_TICKS = 260;
const ZOOM = 1.25;
const FONT = '"Inter Variable", Inter, system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';
const BG = '#060a12';
const ASK_RGB = '244,63,94';
const BID_RGB = '16,185,129';

/**
 * Display colour scale of this page. ratio = displayed size / the reference size of the loaded window (its 99th
 * percentile, from the analysis) x Intensity. Colour = displayed liquidity intensity ONLY (never side / direction):
 * weak = dark subtle blue, moderate = blue / cyan, strong = yellow, very strong = orange, exceptional = red / white-hot.
 */
export const PALETTE: readonly (readonly [number, readonly [number, number, number], number])[] = [
  [0, [12, 26, 64], 0.06],
  [0.3, [28, 58, 160], 0.3],
  [0.5, [37, 99, 235], 0.55],
  [0.65, [34, 211, 238], 0.72],
  [0.85, [250, 204, 21], 0.9],
  [1.1, [249, 115, 22], 0.96],
  [1.4, [239, 68, 68], 1],
  [1.9, [255, 245, 235], 1],
];
export const PALETTE_MAX = 1.9;
export const SCALE_NAMES: readonly (readonly [string, number])[] = [['Weak', 0], ['Moderate', 0.5], ['Strong', 0.85], ['Very strong', 1.1], ['Exceptional', 1.4]];
/** Colour + opacity for a size ratio (pure). */
export function paletteAt(ratio: number): { rgb: [number, number, number]; a: number } {
  const r = Math.max(0, Math.min(PALETTE_MAX, ratio));
  for (let i = 1; i < PALETTE.length; i++) {
    const [x1, c1, a1] = PALETTE[i]!;
    if (r <= x1) {
      const [x0, c0, a0] = PALETTE[i - 1]!;
      const k = (r - x0) / (x1 - x0);
      return { rgb: [0, 1, 2].map((j) => Math.round(c0[j]! + (c1[j]! - c0[j]!) * k)) as [number, number, number], a: a0 + (a1 - a0) * k };
    }
  }
  const last = PALETTE[PALETTE.length - 1]!;
  return { rgb: [...last[1]] as [number, number, number], a: last[2] };
}

type Raf = { request(cb: () => void): number; cancel(id: number): void };
const defaultRaf = (): Raf =>
  typeof requestAnimationFrame === 'function' ? { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) } : { request: (cb) => setTimeout(cb, 50) as unknown as number, cancel: (id) => clearTimeout(id) };

export class LiquidityMapView implements ChartNavigable {
  vp: Viewport | null = null;
  follow = true;
  /** The page's window choice; `anchored` = still showing exactly it (false after a wheel zoom). */
  private range: ViewRange = { kind: 'span', ms: DEFAULT_SPAN_MS };
  /** Nothing is shown (or requested) until the page has chosen the window: one resolution request, not two. */
  private rangeSet = false;
  private anchored = true;
  /** Span last reported to the page (a growing LIVE SESSION re-reports only after a 10 % change: resolution). */
  private emittedSpan = 0;
  private autoPrice = true;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private w = 0;
  private h = 0;
  private ro: ResizeObserver | null = null;
  private frameId: number | null = null;
  private lastVersion = -1;
  private dirty = true;
  private drag: { x: number; y: number; vp: Viewport; zone: 'plot' | 'price' } | null = null;
  private destroyed = false;
  private hoverAt: { x: number; y: number } | null = null;
  private readonly raf: Raf;
  /** Labels drawn in the last frame (tests / diagnostics). */
  lastLabels: string[] = [];
  /** Strong-now bands outlined in the last frame (tests / diagnostics). */
  strongRuns: { side: 'ASK' | 'BID'; tick: number; start: number }[] = [];
  /** Per-column caches of the current analysis (mid tick, cells) - rebuilt when the analysis object changes. */
  private cacheFor: MapResult | null = null;
  private byCol: MapCell[][] = [];
  private strongFor: readonly StrongInterval[] | null | undefined = null;
  private strongSet = new Set<number>();
  private strongCellsFor: MapResult | null = null;
  private index(f: MapFrame): void {
    if (this.cacheFor !== f.result) {
      this.cacheFor = f.result;
      this.strongFor = null;
      this.byCol = f.cols.map(() => []);
      for (const c of f.result?.cells ?? []) this.byCol[c.c]?.push(c);
    }
    if (this.strongFor !== f.strongIntervals || this.strongCellsFor !== f.result) {
      this.strongFor = f.strongIntervals;
      this.strongCellsFor = f.result;
      const byKey = new Map<string, StrongInterval[]>();
      for (const iv of f.strongIntervals ?? []) {
        const k = `${iv.side}${iv.tick}`;
        const l = byKey.get(k);
        if (l) l.push(iv);
        else byKey.set(k, [iv]);
      }
      this.strongSet = new Set();
      (f.result?.cells ?? []).forEach((c, i) => {
        const l = byKey.get(`${c.side}${c.tick}`);
        const col = f.cols[c.c];
        if (l && col && l.some((iv) => iv.from < col.t + col.w && iv.to > col.t)) this.strongSet.add(i);
      });
    }
  }

  constructor(
    private readonly host: HTMLElement,
    private readonly frame: () => MapFrame,
    private readonly opts: { tickSize: number; decimals: number; now?: () => number; raf?: Raf; onViewport?: (v: Viewport | null, plotPx: number) => void; onHover?: (h: HoverInfo | null) => void; onReset?: () => void },
  ) {
    this.raf = opts.raf ?? defaultRaf();
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gcmap__canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'GC liquidity map');
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext?.('2d') ?? null;
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onUp);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    this.canvas.addEventListener('dblclick', this.onDbl);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(host);
    }
    this.resize();
    this.loop();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frameId !== null) this.raf.cancel(this.frameId);
    this.ro?.disconnect();
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('dblclick', this.onDbl);
    this.canvas.remove();
  }
  invalidate(): void {
    this.dirty = true;
  }
  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
  private resize(): void {
    const r = this.host.getBoundingClientRect();
    this.w = Math.max(0, Math.floor(r.width));
    this.h = Math.max(0, Math.floor(r.height));
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.canvas.width = Math.max(1, this.w * dpr);
    this.canvas.height = Math.max(1, this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }
  /** Total drawing width left of the price axis (chart + CURRENT DEPTH column). */
  private drawW(): number {
    return Math.max(1, this.w - AXIS_RIGHT);
  }
  private profileW(): number {
    return this.frame().showDepth ? Math.round(this.drawW() * PROFILE_SHARE) : 0;
  }
  /** Width of the time chart (heat + candles). */
  plotW(): number {
    return Math.max(1, this.drawW() - this.profileW());
  }
  private plotH(): number {
    return Math.max(1, this.h - AXIS_BOTTOM);
  }

  /* ------------------------------- viewport ------------------------------- */

  private set(vp: Viewport | null, emit = true): void {
    this.vp = vp;
    this.dirty = true;
    if (emit) {
      this.emittedSpan = vp ? vp.t1 - vp.t0 : 0;
      this.opts.onViewport?.(vp, this.plotW());
    }
  }
  private centreTick(): number | null {
    const f = this.frame();
    if (f.lastPriceTick !== null) return f.lastPriceTick;
    const c = f.candles[f.candles.length - 1];
    return c ? Math.round(c.c / this.opts.tickSize) : null;
  }
  /** Reset View: back to the page's default window (LIVE SESSION) - the page is told, then the window is applied. */
  resetView(): void {
    this.opts.onReset?.();
    this.applyRange();
  }
  fitView(): void {
    this.applyRange();
  }
  /** Report the current window to the page again (it re-requests recorded depth that did not arrive). */
  reportViewport(): void {
    if (this.vp) this.opts.onViewport?.(this.vp, this.plotW());
  }
  /** The page chose a window. `apply` = show it now (a click); otherwise only the live anchor moves (session update). */
  setRange(r: ViewRange, apply: boolean): void {
    this.range = r;
    this.rangeSet = true;
    if (apply || !this.vp) this.applyRange();
  }
  /** [t0, t1] of the chosen window at `now` (view only). */
  windowOf(now: number): { t0: number; t1: number } {
    const span = this.range.kind === 'span' ? this.range.ms : Math.max(SESSION_MIN_SPAN_MS, now - this.range.start);
    return { t0: now - span, t1: now + lookAhead(span) };
  }
  private applyRange(): void {
    this.follow = true;
    this.autoPrice = true;
    this.anchored = true;
    const c = this.centreTick();
    if (c === null) return this.set(null);
    const { t0, t1 } = this.windowOf(this.now());
    this.set({ t0, t1, p0: c - DEFAULT_TICKS / 2, p1: c + DEFAULT_TICKS / 2 });
  }
  /** Fix the view to a window (no live following until reset). View state only. */
  pin(vp: Viewport): void {
    this.follow = false;
    this.autoPrice = false;
    this.set({ ...vp });
  }
  zoomIn(): void {
    if (!this.vp) this.applyRange();
    this.zoomTime(1 / ZOOM, null);
  }
  zoomOut(): void {
    if (!this.vp) this.applyRange();
    this.zoomTime(ZOOM, null);
  }
  private zoomTime(f: number, anchor: number | null): void {
    const v = this.vp;
    if (!v) return;
    const span = v.t1 - v.t0;
    const next = Math.min(Math.max(span * f, 5 * 60_000), 10 * 86_400_000);
    const a = anchor ?? (this.follow ? v.t1 : (v.t0 + v.t1) / 2);
    const k = (a - v.t0) / span;
    this.anchored = false;
    this.set({ ...v, t0: a - k * next, t1: a - k * next + next });
  }
  private zoomPrice(f: number, anchor: number | null): void {
    const v = this.vp;
    if (!v) return;
    const span = v.p1 - v.p0;
    const next = Math.min(Math.max(span * f, 20), 40_000);
    const a = anchor ?? (v.p0 + v.p1) / 2;
    const k = (a - v.p0) / span;
    this.autoPrice = false;
    this.set({ ...v, p0: a - k * next, p1: a - k * next + next });
  }
  /** Auto price range: candles of the window + the live book + the last price (display only). */
  private autoFit(): void {
    const v = this.vp;
    if (!v) return;
    const f = this.frame();
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of f.candles) {
      if (c.t + c.ms < v.t0 || c.t > v.t1) continue;
      lo = Math.min(lo, c.l / this.opts.tickSize);
      hi = Math.max(hi, c.h / this.opts.tickSize);
    }
    // The live book and the last price are always in view (CURRENT DEPTH must never sit off-screen).
    for (const r of [...(f.book?.bids ?? []), ...(f.book?.asks ?? [])]) {
      lo = Math.min(lo, r.tick);
      hi = Math.max(hi, r.tick);
    }
    if (f.lastPriceTick !== null) {
      lo = Math.min(lo, f.lastPriceTick);
      hi = Math.max(hi, f.lastPriceTick);
    }
    if (!Number.isFinite(lo)) return;
    const pad = Math.max(10, (hi - lo) * 0.12);
    const p0 = lo - pad;
    const p1 = hi + pad;
    if (Math.abs(p0 - v.p0) > 0.5 || Math.abs(p1 - v.p1) > 0.5) this.set({ ...v, p0, p1 }, false);
  }

  /* -------------------------------- input -------------------------------- */

  private local(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private onWheel = (e: WheelEvent) => {
    if (!this.vp) return;
    e.preventDefault();
    const { x, y } = this.local(e);
    const f = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015)));
    const v = this.vp;
    if (x > this.drawW() || e.shiftKey) this.zoomPrice(f, v.p1 - (y / this.plotH()) * (v.p1 - v.p0));
    else this.zoomTime(f, this.follow ? null : v.t0 + (Math.min(x, this.plotW()) / this.plotW()) * (v.t1 - v.t0));
  };
  private onDown = (e: PointerEvent) => {
    if (!this.vp) return;
    const p = this.local(e);
    this.canvas.setPointerCapture?.(e.pointerId);
    this.drag = { ...p, vp: { ...this.vp }, zone: p.x > this.drawW() ? 'price' : 'plot' };
  };
  private onMove = (e: PointerEvent) => {
    const p = this.local(e);
    if (!this.drag) {
      this.hoverAt = p;
      this.dirty = true;
      return;
    }
    const d = this.drag;
    const v = d.vp;
    if (d.zone === 'price') {
      this.autoPrice = false;
      const span = (v.p1 - v.p0) * Math.exp((p.y - d.y) * 0.005);
      const m = (v.p0 + v.p1) / 2;
      this.set({ ...v, p0: m - span / 2, p1: m + span / 2 });
      return;
    }
    const dt = ((p.x - d.x) / this.plotW()) * (v.t1 - v.t0);
    const dp = ((p.y - d.y) / this.plotH()) * (v.p1 - v.p0);
    if (Math.abs(p.x - d.x) > 3) this.follow = false;
    if (Math.abs(p.y - d.y) > 3) this.autoPrice = false;
    this.set({ t0: v.t0 - dt, t1: v.t1 - dt, p0: this.autoPrice ? v.p0 : v.p0 + dp, p1: this.autoPrice ? v.p1 : v.p1 + dp });
  };
  private onUp = () => {
    this.drag = null;
  };
  private onLeave = () => {
    this.hoverAt = null;
    this.drag = null;
    this.dirty = true;
  };
  private onDbl = () => this.resetView();

  /* -------------------------------- render -------------------------------- */

  private loop = () => {
    if (this.destroyed) return;
    const f = this.frame();
    if (f.version !== this.lastVersion) {
      this.lastVersion = f.version;
      this.dirty = true;
    }
    if (!this.vp && this.rangeSet) this.applyRange();
    if (this.vp && this.follow) {
      if (this.anchored) {
        // The chosen window, moved to now (LIVE SESSION keeps its start and grows with the session).
        const w = this.windowOf(this.now());
        if (Math.abs(w.t1 - this.vp.t1) > 1000 || Math.abs(w.t0 - this.vp.t0) > 1000) {
          const span = w.t1 - w.t0;
          this.set({ ...this.vp, ...w }, Math.abs(span - this.emittedSpan) > 0.1 * Math.max(1, this.emittedSpan));
        }
      } else {
        const t1 = this.now() + lookAhead(this.vp.t1 - this.vp.t0);
        if (Math.abs(t1 - this.vp.t1) > 1000) this.set({ ...this.vp, t0: this.vp.t0 + (t1 - this.vp.t1), t1 }, false);
      }
    }
    if (this.autoPrice) this.autoFit();
    if (this.dirty) {
      this.dirty = false;
      this.draw(f);
    }
    this.frameId = this.raf.request(this.loop);
  };

  x(t: number): number {
    const v = this.vp!;
    return ((t - v.t0) / (v.t1 - v.t0)) * this.plotW();
  }
  y(tick: number): number {
    const v = this.vp!;
    return ((v.p1 - tick) / (v.p1 - v.p0)) * this.plotH();
  }

  /**
   * Read-only diagnostics of what this frame shows, as data attributes on the canvas (no values beyond what is drawn):
   * the CURRENT DEPTH rows + their IBKR lastUpdate, the recorded heat extent and the uncovered (gap) intervals.
   * Lets an external check compare the drawn profile with /api/ibkr/book and confirm gaps are not painted.
   */
  private diagnostics(f: MapFrame): void {
    const ds = this.canvas.dataset;
    const tk = this.opts.tickSize;
    const px = (t: number) => Number((t * tk).toFixed(this.opts.decimals));
    ds.depth = f.book ? JSON.stringify({ updateMs: f.bookUpdateMs ?? null, bids: f.book.bids.map((r) => [px(r.tick), r.size]), asks: f.book.asks.map((r) => [px(r.tick), r.size]) }) : 'none';
    const r = f.result;
    const last = f.cols[f.cols.length - 1];
    ds.heatCols = String(f.cols.length);
    ds.heatCells = String(r?.cells.length ?? 0);
    ds.heatFirstMs = String(f.cols[0]?.t ?? '');
    ds.heatLastMs = last ? String(last.valid.length ? last.valid[last.valid.length - 1]! : last.t + last.w) : '';
    ds.bucketMs = String(last?.w ?? '');
    const holes: [number, number][] = [];
    const cov = r?.covered ?? [];
    for (let i = 1; i < cov.length; i++) holes.push([cov[i - 1]![1], cov[i]![0]]);
    ds.gaps = JSON.stringify(holes);
    ds.loading = f.loading ? '1' : '0';
    // Viewport: the visible window and how much of it (up to now) has recorded-valid depth.
    const v = this.vp!;
    const end = Math.min(v.t1, this.now());
    let rec = 0;
    for (const [a, b] of r?.covered ?? []) rec += Math.max(0, Math.min(b, end) - Math.max(a, v.t0));
    ds.vpT0 = String(Math.round(v.t0));
    ds.vpT1 = String(Math.round(v.t1));
    ds.range = this.range.kind === 'session' ? `session:${this.range.start}` : `span:${this.range.ms}`;
    ds.recordedShare = end > v.t0 ? (rec / (end - v.t0)).toFixed(3) : '0';
    ds.plotShare = (this.plotW() / Math.max(1, this.w)).toFixed(3);
    ds.profileShare = (this.profileW() / Math.max(1, this.w)).toFixed(3);
    ds.strongRuns = JSON.stringify(this.strongRuns);
  }

  draw(f: MapFrame): void {
    if (this.vp) this.diagnostics(f);
    const g = this.ctx;
    if (!g || !this.vp || this.w < 20) return;
    this.index(f);
    const W = this.plotW();
    const H = this.plotH();
    g.fillStyle = BG;
    g.fillRect(0, 0, this.w, this.h);
    this.grid(g, W, H);
    g.save();
    g.beginPath();
    g.rect(0, 0, W, H);
    g.clip();
    if (f.showHeat) this.drawHeat(g, f);
    this.drawGaps(g, f, H);
    this.strongRuns = [];
    if (f.showHeat) this.drawStrongBands(g, f);
    if (f.showCandles) this.drawCandles(g, f.candles);
    g.restore();
    this.drawPriceLine(g, f, W);
    if (f.showDepth) this.drawProfile(g, f, W, H);
    this.axes(g, W, H);
    this.lastLabels = [];
    if (f.showHeat && f.showLabels) this.drawLabels(g, f);
    this.drawPriceTag(g, f);
    this.hover(g, f);
  }

  private grid(g: CanvasRenderingContext2D, W: number, H: number): void {
    const v = this.vp!;
    g.strokeStyle = 'rgba(148,163,184,0.06)';
    g.lineWidth = 1;
    const ps = niceStep(v.p1 - v.p0, H / 42);
    for (let p = Math.ceil(v.p0 / ps) * ps; p <= v.p1; p += ps) {
      const y = Math.round(this.y(p)) + 0.5;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
    }
    const ts = niceTime(v.t1 - v.t0, W / 110);
    for (let t = Math.ceil(v.t0 / ts) * ts; t <= v.t1; t += ts) {
      const x = Math.round(this.x(t)) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
    }
  }

  /** Recorded liquidity: one rectangle per (bucket, price), only inside the bucket's recorded-valid time. */
  private drawHeat(g: CanvasRenderingContext2D, f: MapFrame): void {
    const r = f.result;
    if (!r || !(r.refSize > 0)) return;
    const v = this.vp!;
    const rowPx = Math.max(1, this.plotH() / (v.p1 - v.p0));
    const gap = rowPx >= 5 ? 1 : 0; // a hair line between price rows once rows are tall enough to read one by one
    for (let ci = 0; ci < r.cells.length; ci++) {
      const cell = r.cells[ci]!;
      const col = f.cols[cell.c]!;
      if (col.t + col.w < v.t0 || col.t > v.t1 || cell.tick < v.p0 - 1 || cell.tick > v.p1 + 1) continue;
      if (f.strongOnly && !this.strongSet.has(ci)) continue;
      const ratio = (cell.size / r.refSize) * f.gain;
      if (ratio < 0.08) continue;
      const { rgb, a } = paletteAt(ratio);
      g.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;
      const y0 = this.y(cell.tick + 0.5);
      const hh = Math.max(1, rowPx - gap);
      for (let k = 0; k < col.valid.length; k += 2) {
        const x0 = this.x(col.valid[k]!);
        const x1 = this.x(col.valid[k + 1]!);
        g.fillRect(x0, y0, Math.max(0.6, x1 - x0), hh);
      }
    }
  }

  /**
   * STRONG LIQUIDITY NOW: outline each level's recorded band from its 250 ms run start to the latest recorded time
   * (the run is continuous at 250 ms - any gap or absence would have ended it), with a mark at its qualification time.
   */
  private drawStrongBands(g: CanvasRenderingContext2D, f: MapFrame): void {
    const rows = f.strongNow ?? [];
    const cov = f.result?.covered ?? [];
    const lastCov = cov[cov.length - 1];
    if (!rows.length || !lastCov || !f.depthLive) return;
    const v = this.vp!;
    const rowPx = Math.max(1, this.plotH() / (v.p1 - v.p0));
    for (const row of rows) {
      if (row.runStart === null) continue;
      const a = Math.max(row.runStart, lastCov[0]);
      const b = lastCov[1];
      if (b <= a) continue;
      this.strongRuns.push({ side: row.side, tick: row.tick, start: row.runStart });
      const y0 = this.y(row.tick + 0.5);
      const y1 = y0 + Math.max(2, rowPx);
      const x0 = Math.max(0, this.x(a));
      const x1 = Math.min(this.plotW(), this.x(b));
      g.strokeStyle = `rgba(${row.side === 'ASK' ? ASK_RGB : BID_RGB},0.95)`;
      g.lineWidth = 1.5;
      g.beginPath();
      if (x1 > x0) {
        g.moveTo(x0, y0 - 1);
        g.lineTo(x1, y0 - 1);
        g.moveTo(x0, y1 + 1);
        g.lineTo(x1, y1 + 1);
      }
      for (const t of [row.runStart, row.qualifiedAt]) {
        if (t === null) continue;
        const x = this.x(t);
        if (x < 0 || x > this.plotW()) continue;
        g.moveTo(x, y0 - 4);
        g.lineTo(x, y1 + 4);
      }
      g.stroke();
    }
  }

  /** Time with no recorded-valid depth (inside the window, up to now): hatched, never painted as liquidity. */
  private drawGaps(g: CanvasRenderingContext2D, f: MapFrame, H: number): void {
    const v = this.vp!;
    if (f.loading) {
      g.fillStyle = 'rgba(148,163,184,0.8)';
      g.font = `700 10px ${FONT}`;
      g.textAlign = 'center';
      g.fillText('LOADING RECORDED DEPTH…', this.plotW() / 2, 16);
      g.textAlign = 'left';
      return;
    }
    const end = Math.min(v.t1, this.now());
    const cov = f.result?.covered ?? [];
    const holes: [number, number, string][] = [];
    let t = v.t0;
    for (const [a, b] of cov) {
      if (b <= t) continue;
      if (a > t) holes.push([t, Math.min(a, end), 'DEPTH GAP']);
      t = Math.max(t, b);
      if (t >= end) break;
    }
    if (t < end) holes.push([t, end, 'NO DEPTH DATA']);
    for (const [a, b, label] of holes) {
      const x0 = Math.max(0, this.x(a));
      const x1 = Math.min(this.plotW(), this.x(b));
      if (x1 - x0 < 2) continue;
      g.fillStyle = 'rgba(100,116,139,0.07)';
      g.fillRect(x0, 0, x1 - x0, H);
      g.save();
      g.beginPath();
      g.rect(x0, 0, x1 - x0, H);
      g.clip();
      g.strokeStyle = 'rgba(100,116,139,0.14)';
      g.lineWidth = 1;
      g.beginPath();
      for (let k = -H; k < x1 - x0; k += 12) {
        g.moveTo(x0 + k, H);
        g.lineTo(x0 + k + H, 0);
      }
      g.stroke();
      g.restore();
      if (x1 - x0 > 80) {
        g.fillStyle = 'rgba(148,163,184,0.8)';
        g.font = `700 10px ${FONT}`;
        g.textAlign = 'center';
        g.fillText(label, (x0 + x1) / 2, 16);
        g.textAlign = 'left';
      }
    }
  }

  private drawCandles(g: CanvasRenderingContext2D, cs: readonly MapCandle[]): void {
    const v = this.vp!;
    const tk = this.opts.tickSize;
    for (const c of cs) {
      if (c.t + c.ms < v.t0 || c.t > v.t1) continue;
      const x0 = this.x(c.t);
      const x1 = this.x(c.t + c.ms);
      const slot = x1 - x0;
      const bw = Math.max(1, Math.min(9, slot * 0.55));
      const xm = Math.round((x0 + x1) / 2) + 0.5;
      const up = c.c >= c.o;
      const col = up ? '#22c55e' : '#ef4444';
      g.strokeStyle = col;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(xm, this.y(c.h / tk));
      g.lineTo(xm, this.y(c.l / tk));
      g.stroke();
      const yo = this.y(c.o / tk);
      const yc = this.y(c.c / tk);
      g.fillStyle = col;
      g.fillRect(xm - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    }
  }

  private priceTick(f: MapFrame): number | null {
    if (f.lastPriceTick !== null) return f.lastPriceTick;
    const c = f.candles[f.candles.length - 1];
    return c ? Math.round(c.c / this.opts.tickSize) : null;
  }
  private drawPriceLine(g: CanvasRenderingContext2D, f: MapFrame, W: number): void {
    const p = this.priceTick(f);
    if (p === null) return;
    const y = Math.round(this.y(p)) + 0.5;
    if (y < 0 || y > this.plotH()) return;
    g.strokeStyle = 'rgba(250,250,250,0.75)';
    g.setLineDash([6, 4]);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W + this.profileW(), y);
    g.stroke();
    g.setLineDash([]);
  }
  private drawPriceTag(g: CanvasRenderingContext2D, f: MapFrame): void {
    const p = this.priceTick(f);
    if (p === null) return;
    const y = this.y(p);
    if (y < 0 || y > this.plotH()) return;
    const x = this.drawW();
    g.fillStyle = '#fbbf24';
    g.beginPath();
    g.moveTo(x - 6, y);
    g.lineTo(x, y - 12);
    g.lineTo(x + AXIS_RIGHT, y - 12);
    g.lineTo(x + AXIS_RIGHT, y + 12);
    g.lineTo(x, y + 12);
    g.closePath();
    g.fill();
    g.fillStyle = '#0b0f19';
    g.font = `800 12.5px ${MONO}`;
    g.textBaseline = 'middle';
    g.fillText((p * this.opts.tickSize).toFixed(this.opts.decimals), x + 4, y + 0.5);
    g.textBaseline = 'alphabetic';
  }

  /** CURRENT DEPTH: the live visible IBKR book only (asks above / bids below), bars grow left from the axis. */
  private drawProfile(g: CanvasRenderingContext2D, f: MapFrame, W: number, H: number): void {
    const pw = this.profileW();
    const x0 = W;
    g.fillStyle = 'rgba(15,23,42,0.85)';
    g.fillRect(x0, 0, pw, H);
    g.strokeStyle = 'rgba(148,163,184,0.18)';
    g.beginPath();
    g.moveTo(x0 + 0.5, 0);
    g.lineTo(x0 + 0.5, H);
    g.stroke();
    g.fillStyle = 'rgba(203,213,225,0.85)';
    g.font = `700 10px ${FONT}`;
    g.fillText('CURRENT DEPTH', x0 + 8, 15);
    const b = f.book;
    if (!b) {
      g.fillStyle = 'rgba(251,191,36,0.9)';
      g.fillText('NO DEPTH DATA', x0 + 8, 32);
      return;
    }
    const v = this.vp!;
    const rowPx = Math.max(2, this.plotH() / (v.p1 - v.p0));
    const max = Math.max(1, ...b.bids.map((r) => r.size), ...b.asks.map((r) => r.size));
    const showSize = rowPx >= 7;
    g.font = `600 ${Math.min(11, Math.max(8, rowPx - 1))}px ${MONO}`;
    g.textBaseline = 'middle';
    const bar = (r: DepthRow, rgb: string) => {
      const y = this.y(r.tick + 0.5);
      if (y > H || y + rowPx < 18) return;
      const len = ((pw - 30) * r.size) / max;
      g.fillStyle = `rgba(${rgb},0.88)`;
      g.fillRect(x0 + pw - 2 - len, y + 0.5, len, Math.max(1, rowPx - 1));
      if (showSize) {
        g.fillStyle = 'rgba(226,232,240,0.9)';
        g.textAlign = 'right';
        g.fillText(fmtSize(r.size), x0 + pw - 6 - len, y + rowPx / 2);
        g.textAlign = 'left';
      }
    };
    for (const r of b.asks) bar(r, ASK_RGB);
    for (const r of b.bids) bar(r, BID_RGB);
    g.textBaseline = 'alphabetic';
  }

  /** Labels of the STRONG LIQUIDITY NOW rows at the live edge of their band: "ASK 4198.0  SIZE 16  3.2×  AGE 00:45". */
  private drawLabels(g: CanvasRenderingContext2D, f: MapFrame): void {
    if (!f.depthLive) return;
    const used: [number, number][] = [];
    const rows = [...(f.strongNow ?? [])].sort((a, b) => b.size - a.size);
    for (const c of rows) {
      const yc = this.y(c.tick);
      if (yc < 12 || yc > this.plotH() - 12) continue;
      let y = yc;
      while (used.some(([a, b]) => y > a - 2 && y < b + 2)) y += c.side === 'ASK' ? -22 : 22;
      if (y < 12 || y > this.plotH() - 12) continue;
      const text = `${c.side} ${(c.tick * this.opts.tickSize).toFixed(this.opts.decimals)}   SIZE ${fmtSize(c.size)}   ${c.relative.toFixed(1)}×   AGE ${c.lowerBound ? '≥' : ''}${fmtAge(c.observedMs)}`;
      g.font = `700 11px ${FONT}`;
      const w = g.measureText(text).width + 16;
      const x = Math.max(4, this.plotW() - w - 8);
      const rgb = c.side === 'ASK' ? ASK_RGB : BID_RGB;
      g.fillStyle = 'rgba(6,10,18,0.92)';
      g.fillRect(x, y - 10, w, 20);
      g.strokeStyle = `rgba(${rgb},0.95)`;
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y - 9.5, w - 1, 19);
      g.fillStyle = `rgb(${rgb})`;
      g.fillRect(x, y - 10, 4, 20);
      if (y !== yc) {
        g.beginPath();
        g.moveTo(x + w / 2, y + (y < yc ? 10 : -10));
        g.lineTo(x + w / 2, yc);
        g.stroke();
      }
      g.fillStyle = '#f1f5f9';
      g.textBaseline = 'middle';
      g.fillText(text, x + 10, y + 0.5);
      g.textBaseline = 'alphabetic';
      used.push([y - 10, y + 10]);
      this.lastLabels.push(text);
    }
  }

  private axes(g: CanvasRenderingContext2D, W: number, H: number): void {
    const v = this.vp!;
    const ax = this.drawW();
    g.fillStyle = 'rgba(148,163,184,0.85)';
    g.font = `10.5px ${MONO}`;
    const ps = niceStep(v.p1 - v.p0, H / 42);
    for (let p = Math.ceil(v.p0 / ps) * ps; p <= v.p1; p += ps) {
      const y = this.y(p);
      if (y < 8 || y > H - 4) continue;
      g.fillText((p * this.opts.tickSize).toFixed(this.opts.decimals), ax + 6, y + 3.5);
    }
    g.textAlign = 'center';
    const ts = niceTime(v.t1 - v.t0, W / 110);
    for (let t = Math.ceil(v.t0 / ts) * ts; t <= v.t1; t += ts) {
      const x = this.x(t);
      if (x < 26 || x > W - 26) continue;
      const iso = new Date(t).toISOString();
      g.fillText(ts >= 86_400_000 ? iso.slice(5, 10) : iso.slice(11, 16), x, H + 15);
    }
    g.textAlign = 'left';
    g.strokeStyle = 'rgba(148,163,184,0.18)';
    g.beginPath();
    g.moveTo(ax + 0.5, 0);
    g.lineTo(ax + 0.5, H);
    g.moveTo(0, H + 0.5);
    g.lineTo(ax, H + 0.5);
    g.stroke();
  }

  private hover(g: CanvasRenderingContext2D, f: MapFrame): void {
    const p = this.hoverAt;
    let info: HoverInfo | null = null;
    if (p && f.result && p.x < this.plotW() && p.y < this.plotH()) {
      const v = this.vp!;
      const t = v.t0 + (p.x / this.plotW()) * (v.t1 - v.t0);
      const tick = Math.round(v.p1 - (p.y / this.plotH()) * (v.p1 - v.p0));
      const ci = f.cols.findIndex((c) => t >= c.t && t < c.t + c.w);
      const col = ci >= 0 ? f.cols[ci]! : null;
      const inValid = col ? validAt(col, t) : false;
      const cell = col && inValid ? ((this.byCol[ci] ?? []).find((c) => c.tick === tick) ?? null) : null;
      if (cell && col && (!f.strongOnly || this.strongSet.has(f.result.cells.indexOf(cell)))) {
        info = { x: p.x, y: p.y, cell, col };
        g.strokeStyle = 'rgba(255,255,255,0.8)';
        g.lineWidth = 1;
        const y0 = this.y(tick + 0.5);
        g.strokeRect(this.x(col.t) + 0.5, y0 + 0.5, Math.max(2, this.x(col.t + col.w) - this.x(col.t)), Math.max(2, this.plotH() / (v.p1 - v.p0)));
      }
    }
    this.opts.onHover?.(info);
  }
}

/** Empty space right of "now" while following live (never filled with data): 3 % of the span, at least 15 s. */
const lookAhead = (span: number) => Math.max(15_000, span * 0.03);
function validAt(c: MapColumn, t: number): boolean {
  for (let i = 0; i < c.valid.length; i += 2) if (t >= c.valid[i]! && t < c.valid[i + 1]!) return true;
  return false;
}
export const fmtSize = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
export function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
function niceStep(span: number, maxLines: number): number {
  const raw = span / Math.max(1, maxLines);
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000]) if (s >= raw) return s;
  return 10_000;
}
function niceTime(span: number, maxLines: number): number {
  const raw = span / Math.max(1, maxLines);
  for (const s of [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000]) if (s >= raw) return s;
  return 172_800_000;
}
