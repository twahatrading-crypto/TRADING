import type { HeatmapViewSettings } from '../../engines/orderFlow/config';
import type { HeatmapColumn, OrderFlowEngine } from '../../engines/orderFlow/engine';
import type { ChartNavigable } from '../chart/ChartStage';
import { colorAt, columnRows, intensity, percentile, smooth, type Viewport } from './heatmapMath';
import { columnAt, type DepthHistory, type HistoryColumn } from './depthHistory';
import {
  aggregateDots,
  autoBucketMs,
  bandTicksFor,
  dominance,
  dotRadius,
  lowerBound,
  autoPriceWindow,
  CATCH_UP_LAG_MS,
  priceBars,
  priceBucketFor,
  upperBound,
  type PriceWindow,
  quantileTotal,
  stepTrace,
  TradeTape,
  type DisplayTrade,
  type Dominance,
  type DotAggregation,
  type TradeSource,
} from './tradeDots';

/* ============================================================================
 * Canvas liquidity heatmap: batched rendering (one requestAnimationFrame loop; a frame is drawn
 * only when the engine version or the viewport changed — never one React render per update).
 * Everything here is VIEW state: zoom / pan / scale / fit / reset only change the Viewport.
 * The engine is read, never written. Implements ChartNavigable, so the shared TLUXE ChartStage
 * controls (Zoom In / Out, Fit, Reset, Alt+R) drive it.
 * ========================================================================== */

export const AXIS_RIGHT = 70;
export const AXIS_BOTTOM = 22;
export const DEFAULT_SPAN_COLUMNS = 180;
export const DEFAULT_PRICE_TICKS = 60;
/** With little history (e.g. just after connecting) the default window starts at the first real column (min 30). */
export const MIN_SPAN_COLUMNS = 30;
const ZOOM = 1.25;
/** Smallest auto-fitted price range (ticks) - a quiet tape is not stretched into noise. */
export const MIN_AUTO_TICKS = 20;

/** A drawn executed-volume bubble (for hover): exact sums of the real trades in that DISPLAY bucket. */
export interface TradeHover {
  x: number;
  y: number;
  /** Exchange time of the first / last trade in the bucket, and the display bucket width. */
  first: number;
  last: number;
  bucketMs: number;
  /** Volume-weighted price of the bucket and the price band it covers. */
  price: number;
  bandLo: number;
  bandHi: number;
  /** Number of real trades (null when only per-price engine cells were available). */
  count: number | null;
  buy: number;
  sell: number;
  unknown: number;
  total: number;
  dominant: Dominance;
}

type Raf = { request: (cb: () => void) => number; cancel: (id: number) => void };
const defaultRaf = (): Raf =>
  typeof requestAnimationFrame === 'function'
    ? { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) }
    : { request: (cb) => setTimeout(cb, 16) as unknown as number, cancel: (id) => clearTimeout(id) };

export interface HeatmapViewOptions {
  settings: () => HeatmapViewSettings;
  onViewport?: (vp: Viewport | null) => void;
  raf?: Raf;
  decimals: number;
  tickSize: number;
  /** false = the provider has NO Level-2 at all: no liquidity cells and no gap hatch are drawn (nothing is inferred). */
  depthAvailable?: () => boolean;
  /** UI toggle for the liquidity layer (cells + right-edge depth). */
  showCells?: () => boolean;
  /** Hovered executed-volume bubble (exact sums of real trades) or null. */
  onHover?: (h: TradeHover | null) => void;
  /**
   * The raw accepted messages (live recording or replay prefix), READ ONLY: trades are drawn at their own exchange
   * time. Without it the chart falls back to the engine's per-column trade cells.
   */
  tape?: () => TradeSource | null;
  /** Display bucket for the executed-volume dots and the price trace (display only; default AUTO). */
  dotAggregation?: () => DotAggregation;
  /**
   * Server-recorded IBKR depth history (time × price matrix of OBSERVED displayed size). When present it supplies the
   * liquidity layer up to its recorded edge; the live engine columns are used only after that edge. Nothing is drawn
   * before its first recorded snapshot.
   */
  history?: () => DepthHistory | null;
}

/** A liquidity column from either source, as the renderer needs it. */
type LiqColumn = { t: number; w: number; valid: boolean; bidTicks: Int32Array; bidSizes: Float64Array; askTicks: Int32Array; askSizes: Float64Array };

/** Colours per dominant side. UNKNOWN is never shown as a side. */
const DOT_FILL: Record<Dominance, string> = {
  BUY: 'rgba(34,197,94,0.78)',
  SELL: 'rgba(239,68,68,0.78)',
  MIXED: 'rgba(167,139,250,0.72)',
  UNKNOWN: 'rgba(156,163,175,0.35)',
};
const DOT_RING: Record<Dominance, string | null> = { BUY: null, SELL: null, MIXED: 'rgba(221,214,254,0.85)', UNKNOWN: 'rgba(209,213,219,0.9)' };

export class HeatmapView implements ChartNavigable {
  vp: Viewport | null = null;
  follow = true;
  autoPrice = true;
  highlight: { t: number; tick: number } | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private off: HTMLCanvasElement | null = null;
  private raf: Raf;
  private frameId: number | null = null;
  private lastVersion = -1;
  private dirty = true;
  private w = 0;
  private h = 0;
  private ro: ResizeObserver | null = null;
  private drag: { x: number; y: number; zone: 'plot' | 'price' | 'time'; vp: Viewport } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; vp: Viewport } | null = null;
  private destroyed = false;
  private lastEmit = 0;
  /** Default window grows with the available history until DEFAULT_SPAN_COLUMNS (cleared by any manual zoom). */
  private autoSpan = true;
  private bubbles: { x: number; y: number; r: number; h: Omit<TradeHover, 'x' | 'y'> }[] = [];
  private tapeIndex: TradeTape;
  /** Volume-dot display bucket used by the last frame (ms) - diagnostics / tests. */
  lastBucketMs: number | null = null;
  /** Price micro-candle bucket of the last frame (ms) - depends on the viewport only. */
  lastPriceMs: number | null = null;
  /** AUTO price window of the default (following) view; null once the user zooms / pans. */
  private autoWin: PriceWindow | null = null;
  /** Pixel geometry of the last drawn PRICE layer (trace + candles) - identical whatever the dot settings. */
  private priceGeom: number[] = [];
  private hovered: TradeHover | null = null;
  private lastHistVersion = -1;

  constructor(
    private readonly host: HTMLElement,
    private readonly source: () => OrderFlowEngine | null,
    private readonly opts: HeatmapViewOptions,
  ) {
    this.raf = opts.raf ?? defaultRaf();
    this.tapeIndex = new TradeTape(opts.tickSize);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ofheat__canvas';
    this.canvas.setAttribute('aria-label', 'Liquidity heatmap');
    this.canvas.setAttribute('role', 'img');
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext?.('2d') ?? null;
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onUp);
    this.canvas.addEventListener('dblclick', this.onDbl);
    this.canvas.addEventListener('pointerleave', this.onLeave);
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
    this.canvas.removeEventListener('dblclick', this.onDbl);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.remove();
  }

  /** The engine or settings changed (e.g. replay swap): redraw. */
  invalidate(): void {
    this.dirty = true;
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

  /* ------------------------------- viewport ------------------------------- */

  private agg(): number {
    return this.source()?.settings.timeAggregationMs ?? 1000;
  }
  /**
   * Executed trades sorted by EXCHANGE time: from the raw tape when available (a late-delivered backlog is placed
   * where it happened), otherwise from the engine's per-column cells. Read only.
   */
  private trades(): readonly DisplayTrade[] {
    if (this.opts.tape) return this.tapeIndex.sync(this.opts.tape());
    const out: DisplayTrade[] = [];
    for (const c of this.source()?.allColumns() ?? [])
      for (const x of c.trades) {
        if (x.buy) out.push({ t: c.t, tick: x.tick, size: x.buy, side: 'BUY' });
        if (x.sell) out.push({ t: c.t, tick: x.tick, size: x.sell, side: 'SELL' });
        if (x.unknown) out.push({ t: c.t, tick: x.tick, size: x.unknown, side: 'UNKNOWN' });
      }
    return out;
  }
  private latest(): { t: number; tick: number | null } | null {
    const e = this.source();
    if (!e) return null;
    const cols = e.allColumns();
    const last = cols[cols.length - 1];
    if (!last) return null;
    const tr = this.opts.tape ? this.trades() : [];
    const lt = tr[tr.length - 1];
    // Current price = the trade with the latest EXCHANGE time (not the last one delivered).
    if (lt) return { t: Math.max(last.t, lt.t), tick: lt.tick };
    let tick = last.lastTick;
    if (tick === null) {
      for (let i = cols.length - 1; i >= 0 && tick === null; i--) {
        const c = cols[i]!;
        if (c.bestBid !== null && c.bestAsk !== null) tick = Math.round((c.bestBid + c.bestAsk) / 2);
      }
    }
    return { t: last.t, tick };
  }
  private set(vp: Viewport | null): void {
    this.vp = vp;
    this.dirty = true;
  }
  private emitViewport(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 200) return;
    this.lastEmit = now;
    this.opts.onViewport?.(this.vp);
  }
  /** Default view: the last DEFAULT_SPAN_COLUMNS columns, price centred on the current price, following live. */
  resetView(): void {
    const l = this.latest();
    this.follow = true;
    this.autoPrice = true;
    this.highlight = null;
    if (!l) return this.set(null);
    const agg = this.agg();
    const t1 = l.t + 2 * agg;
    const c = l.tick ?? 0;
    this.autoSpan = true;
    this.set({ t0: t1 - this.defaultSpan(t1), t1, p0: c - DEFAULT_PRICE_TICKS / 2, p1: c + DEFAULT_PRICE_TICKS / 2 });
    this.emitViewport(true);
  }
  /**
   * Default time span. With the raw tape: the AUTO price window ending at the latest exchange time (~140 real
   * micro-candles, fewer when the market is quiet - see autoPriceWindow). Without it: DEFAULT_SPAN_COLUMNS, or less
   * when less history exists.
   */
  private defaultSpan(t1: number): number {
    const agg = this.agg();
    if (this.opts.tape) {
      const tr = this.trades();
      const win = autoPriceWindow(tr, t1 - 2 * agg, Math.max(1, this.plotW()));
      this.autoWin = win;
      return win.span + 2 * agg;
    }
    const first = this.source()?.allColumns()[0];
    const have = first ? t1 - first.t + agg : 0;
    return Math.max(MIN_SPAN_COLUMNS * agg, Math.min(DEFAULT_SPAN_COLUMNS * agg, have));
  }
  /** Fit: all retained history and every price that has liquidity or prints. */
  fitView(): void {
    const e = this.source();
    const cols = e?.allColumns() ?? [];
    if (!cols.length) return this.resetView();
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of cols) {
      const ticks = [...c.bidTicks, ...c.askTicks, ...c.trades.map((x) => x.tick)];
      for (const t of ticks) {
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
    }
    const tr = this.trades();
    for (const x of tr) {
      lo = Math.min(lo, x.tick);
      hi = Math.max(hi, x.tick);
    }
    if (!Number.isFinite(lo)) return this.resetView();
    const agg = this.agg();
    const t0 = Math.min(cols[0]!.t, tr[0]?.t ?? Infinity);
    const t1 = Math.max(cols[cols.length - 1]!.t, tr[tr.length - 1]?.t ?? -Infinity) + 2 * agg;
    this.follow = true;
    this.autoPrice = false;
    this.autoSpan = false;
    this.set({ t0, t1, p0: lo - 2, p1: hi + 3 });
    this.emitViewport(true);
  }
  private zoomTime(f: number, anchor: number | null): void {
    const v = this.vp;
    if (!v) return;
    const span = v.t1 - v.t0;
    const agg = this.agg();
    const next = Math.min(Math.max(span * f, 10 * agg), 20_000 * agg);
    this.autoSpan = false;
    const a = anchor ?? (this.follow ? v.t1 : (v.t0 + v.t1) / 2);
    const k = (a - v.t0) / span;
    this.set({ ...v, t0: a - k * next, t1: a - k * next + next });
    this.emitViewport();
  }
  private zoomPrice(f: number, anchor: number | null): void {
    const v = this.vp;
    if (!v) return;
    const span = v.p1 - v.p0;
    const next = Math.min(Math.max(span * f, 6), 20_000);
    const a = anchor ?? (v.p0 + v.p1) / 2;
    const k = (a - v.p0) / span;
    this.autoPrice = false;
    this.set({ ...v, p0: a - k * next, p1: a - k * next + next });
  }
  zoomIn(): void {
    if (!this.vp) this.resetView();
    this.zoomTime(1 / ZOOM, null);
  }
  zoomOut(): void {
    if (!this.vp) this.resetView();
    this.zoomTime(ZOOM, null);
  }
  /** Centre on an event (Recent Events click) and highlight it. */
  focus(t: number, price: number): void {
    if (!this.vp) this.resetView();
    const v = this.vp;
    if (!v) return;
    const tick = Math.round(price / this.opts.tickSize);
    const ts = v.t1 - v.t0;
    const ps = v.p1 - v.p0;
    this.follow = false;
    this.autoPrice = false;
    this.autoSpan = false;
    this.highlight = { t, tick };
    this.set({ t0: t - ts / 2, t1: t + ts / 2, p0: tick - ps / 2, p1: tick + ps / 2 });
    this.emitViewport(true);
  }

  /* -------------------------------- input -------------------------------- */

  private plotW(): number {
    return Math.max(1, this.w - AXIS_RIGHT);
  }
  private plotH(): number {
    return Math.max(1, this.h - AXIS_BOTTOM);
  }
  private zone(x: number, y: number): 'plot' | 'price' | 'time' {
    if (x > this.plotW()) return 'price';
    if (y > this.plotH()) return 'time';
    return 'plot';
  }
  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private onWheel = (e: WheelEvent) => {
    if (!this.vp) return;
    e.preventDefault();
    const { x, y } = this.local(e);
    const f = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015)));
    const v = this.vp;
    if (this.zone(x, y) === 'price' || e.shiftKey) this.zoomPrice(f, v.p1 - (y / this.plotH()) * (v.p1 - v.p0));
    else this.zoomTime(f, this.follow && !e.ctrlKey ? null : v.t0 + (x / this.plotW()) * (v.t1 - v.t0));
  };
  private onDown = (e: PointerEvent) => {
    if (!this.vp) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.canvas.setPointerCapture?.(e.pointerId);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), vp: { ...this.vp } };
      this.drag = null;
      return;
    }
    this.drag = { ...p, zone: this.zone(p.x, p.y), vp: { ...this.vp } };
  };
  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) {
      this.hover(this.local(e));
      return;
    }
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (d > 0) {
        this.vp = { ...this.pinch.vp };
        this.zoomTime(this.pinch.dist / d, null);
      }
      return;
    }
    const g = this.drag;
    if (!g) return;
    const dx = p.x - g.x;
    const dy = p.y - g.y;
    const v = g.vp;
    if (g.zone === 'plot') {
      const dt = (-dx / this.plotW()) * (v.t1 - v.t0);
      const dp = (dy / this.plotH()) * (v.p1 - v.p0);
      if (Math.abs(dx) + Math.abs(dy) > 2) {
        this.follow = false;
        this.autoPrice = false;
      }
      this.set({ t0: v.t0 + dt, t1: v.t1 + dt, p0: v.p0 + dp, p1: v.p1 + dp });
    } else if (g.zone === 'price') {
      const f = Math.exp(dy * 0.01);
      const mid = (v.p0 + v.p1) / 2;
      const half = ((v.p1 - v.p0) / 2) * f;
      this.autoPrice = false;
      this.set({ ...v, p0: mid - half, p1: mid + half });
    } else {
      const f = Math.exp(-dx * 0.01);
      const span = (v.t1 - v.t0) * f;
      this.set({ ...v, t0: v.t1 - span });
    }
    this.emitViewport();
  };
  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.drag = null;
    this.emitViewport(true);
  };
  private onDbl = () => this.resetView();
  private onLeave = () => this.setHover(null);
  private hover(p: { x: number; y: number }): void {
    let best: (typeof this.bubbles)[number] | null = null;
    let bd = Infinity;
    for (const b of this.bubbles) {
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (d <= Math.max(b.r, 4) + 2 && d < bd) {
        bd = d;
        best = b;
      }
    }
    this.setHover(best ? { x: best.x, y: best.y, ...best.h } : null);
  }
  private setHover(h: TradeHover | null): void {
    if (h === this.hovered || (h && this.hovered && h.first === this.hovered.first && h.price === this.hovered.price)) return;
    this.hovered = h;
    this.opts.onHover?.(h);
  }

  /* ------------------------------- drawing ------------------------------- */

  private loop = () => {
    if (this.destroyed) return;
    const e = this.source();
    const ver = e?.version ?? -1;
    const hv = this.opts.history?.()?.version ?? -1;
    if (hv !== this.lastHistVersion) {
      this.lastHistVersion = hv;
      this.dirty = true;
    }
    if (ver !== this.lastVersion) {
      this.lastVersion = ver;
      this.dirty = true;
      if (!this.vp && e && e.allColumns().length) this.resetView();
    }
    if (this.dirty && this.vp) {
      const l = this.latest();
      const agg = this.agg();
      if (this.follow && l) {
        const t1 = l.t + 2 * agg;
        const span = this.autoSpan ? this.defaultSpan(t1) : this.vp.t1 - this.vp.t0;
        this.vp = { ...this.vp, t1, t0: t1 - span };
      }
      if (this.autoPrice && l && l.tick !== null) this.vp = { ...this.vp, ...this.autoPriceRange(this.vp, l.tick) };
    }
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
    this.frameId = this.raf.request(this.loop);
  };

  /** Auto price scale: the visible real trades (and the current price) with padding, at least MIN_AUTO_TICKS tall. */
  private autoPriceRange(v: Viewport, cur: number): { p0: number; p1: number } {
    const tr = this.trades();
    let lo = cur;
    let hi = cur;
    for (let i = lowerBound(tr, v.t0); i < tr.length && tr[i]!.t <= v.t1; i++) {
      const k = tr[i]!.tick;
      if (k < lo) lo = k;
      if (k > hi) hi = k;
    }
    const span = Math.max(MIN_AUTO_TICKS, (hi - lo) * 1.3 + 4);
    const mid = (lo + hi) / 2;
    return { p0: mid - span / 2, p1: mid + span / 2 };
  }

  /** Price-layer geometry of the last frame (for regression tests: must not depend on dot settings). */
  priceGeometry(): string {
    return JSON.stringify(this.priceGeom);
  }

  private visibleColumns(cols: readonly HeatmapColumn[], v: Viewport, agg: number): HeatmapColumn[] {
    let lo = 0;
    let hi = cols.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cols[m]!.t + agg < v.t0) lo = m + 1;
      else hi = m;
    }
    const out: HeatmapColumn[] = [];
    for (let i = lo; i < cols.length && cols[i]!.t <= v.t1; i++) out.push(cols[i]!);
    return out;
  }

  /** Live engine column covering t (binary search over the visible columns). */
  private engineColumnAt(vis: readonly HeatmapColumn[], t: number, agg: number): HeatmapColumn | null {
    let lo = 0;
    let hi = vis.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const c = vis[m]!;
      if (t < c.t) hi = m - 1;
      else if (t >= c.t + agg) lo = m + 1;
      else return c;
    }
    return null;
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || !this.w || !this.h) return;
    const s = this.opts.settings();
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, this.w, this.h);
    const e = this.source();
    const v = this.vp;
    if (!e || !v) return;
    const pw = this.plotW();
    const ph = this.plotH();
    const agg = this.agg();
    const cols = e.allColumns();
    const vis = this.visibleColumns(cols, v, agg);
    const X = (t: number) => ((t - v.t0) / (v.t1 - v.t0)) * pw;
    const Y = (tick: number) => ph - ((tick - v.p0) / (v.p1 - v.p0)) * ph;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, pw, ph);
    ctx.clip();

    // 1) Liquidity cells: one image pixel per plot x × price row. Each x takes the column that covers its time: the
    //    server-recorded IBKR history up to its recorded edge, the live engine columns after it (one source per instant,
    //    so the join has no duplicate and no invented bridge). No column = no data (background); an invalid live column
    //    = NO DATA hatch. Nothing before the first recorded depth snapshot.
    const pAgg = Math.max(1, Math.round(s.priceAggregation), Math.ceil((v.p1 - v.p0) / Math.max(1, ph)));
    const base = Math.floor(v.p0 / pAgg) * pAgg;
    const rows = Math.max(1, Math.ceil((v.p1 - base) / pAgg) + 1);
    const depthOn = this.opts.depthAvailable?.() ?? true;
    const cellsOn = depthOn && (this.opts.showCells?.() ?? true);
    const hist = this.opts.history?.() ?? null;
    if (hist && cellsOn) hist.ensure(v.t0, v.t1, pw);
    const histEnd = hist?.coverEnd() ?? null;
    const first = hist?.firstRecordedMs ?? null;
    let preFirstPx = 0;
    let histCols = 0;
    const W = Math.max(1, Math.round(pw));
    if (cellsOn && (vis.length || (hist && hist.columns.length))) {
      const at = (t: number): LiqColumn | null => {
        if (hist && histEnd !== null && t < histEnd) {
          const hc: HistoryColumn | null = columnAt(hist.columns, t);
          return hc ? { ...hc, valid: true } : null;
        }
        const ec = this.engineColumnAt(vis, t, agg);
        return ec ? { ...ec, w: agg } : null;
      };
      // Column per pixel (consecutive pixels usually share one) and the normalization over the distinct visible ones.
      const pix: (LiqColumn | null)[] = new Array(W);
      const seen = new Set<LiqColumn | HeatmapColumn | HistoryColumn>();
      const distinct: LiqColumn[] = [];
      let prevKey: number | null = null;
      let prevCol: LiqColumn | null = null;
      for (let x = 0; x < W; x++) {
        const t = v.t0 + ((x + 0.5) / W) * (v.t1 - v.t0);
        let c: LiqColumn | null;
        if (prevCol && t >= prevCol.t && t < prevCol.t + prevCol.w && prevKey === (histEnd !== null && t < histEnd ? 1 : 0)) c = prevCol;
        else {
          c = at(t);
          prevKey = histEnd !== null && t < histEnd ? 1 : 0;
          if (c && !seen.has(c)) {
            seen.add(c);
            distinct.push(c);
          }
        }
        prevCol = c;
        pix[x] = c;
      }
      histCols = distinct.filter((c) => histEnd !== null && c.t < histEnd).length;
      const vals: number[] = [];
      // Auto normalization: the visible columns; otherwise everything loaded (recorded history + live columns).
      const normSrc: readonly { valid: boolean; bidSizes: Float64Array; askSizes: Float64Array }[] = s.autoNormalize ? distinct : [...(hist?.columns.map((c) => ({ ...c, valid: true })) ?? []), ...cols];
      for (const c of normSrc) {
        if (!c.valid) continue;
        for (const z of c.bidSizes) vals.push(z);
        for (const z of c.askSizes) vals.push(z);
      }
      const lo = percentile(vals, s.lowerCutoff);
      const hi = percentile(vals, s.upperCutoff);
      if (!this.off) this.off = document.createElement('canvas');
      this.off.width = W;
      this.off.height = rows;
      const octx = this.off.getContext('2d');
      if (octx) {
        const img = octx.createImageData(W, rows);
        const bg = colorAt(0, s.colorScheme);
        const cache = new Map<LiqColumn, Float64Array | null>();
        const lut: [number, number, number][] = Array.from({ length: 256 }, (_, i) => colorAt(i / 255, s.colorScheme));
        const firstX = first !== null ? ((first - v.t0) / (v.t1 - v.t0)) * W : null;
        for (let x = 0; x < W; x++) {
          const c = pix[x];
          let colVals: Float64Array | null | undefined = null;
          if (c) {
            colVals = cache.get(c);
            if (colVals === undefined) {
              colVals = c.valid ? smooth(columnRows(c as unknown as HeatmapColumn, base, rows, pAgg), s.smoothing) : null;
              cache.set(c, colVals);
            }
          }
          for (let r = 0; r < rows; r++) {
            const o = ((rows - 1 - r) * W + x) * 4;
            let rgb: [number, number, number] = bg;
            if (c && !c.valid) rgb = r % 4 < 2 ? [34, 38, 48] : [26, 29, 38]; // gap in a REAL book: NO DATA hatch — never inferred
            else if (colVals) {
              const k = intensity(colVals[r]!, lo, hi, s.contrast, s.minDepth);
              if (k > 0) {
                rgb = lut[Math.min(255, Math.max(1, Math.round(k * 255)))]!;
                if (firstX !== null && x < firstX) preFirstPx += 1; // must stay 0: no depth before the first record
              }
            }
            img.data[o] = rgb[0];
            img.data[o + 1] = rgb[1];
            img.data[o + 2] = rgb[2];
            img.data[o + 3] = 255;
          }
        }
        octx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.off, 0, 0, W, rows, 0, Y(base + rows * pAgg), pw, Y(base) - Y(base + rows * pAgg));
      }
    }
    // Recorded-history boundary: depth recording starts here; the heatmap is empty before it (never backfilled).
    if (cellsOn && first !== null && first > v.t0 && first < v.t1) {
      const xf = X(first);
      ctx.strokeStyle = 'rgba(148,163,184,0.55)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(xf, 0);
      ctx.lineTo(xf, ph);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    this.canvas.dataset.firstDepthMs = first === null ? '' : String(first);
    this.canvas.dataset.preFirstPx = String(preFirstPx);
    this.canvas.dataset.histCols = String(histCols);
    this.canvas.dataset.histBucket = String(hist?.bucketMs ?? '');
    this.canvas.dataset.histEnd = histEnd === null ? '' : String(histEnd);
    // 2) Best bid / ask steps - genuine Level-2 only (a trades-only feed has none).
    const step = (key: 'bestBid' | 'bestAsk', color: string, off: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let open = false;
      for (const c of vis) {
        const tk = c[key];
        if (tk === null || !c.valid) {
          open = false;
          continue;
        }
        const y = Y(tk + off);
        if (!open) ctx.moveTo(X(c.t), y);
        else ctx.lineTo(X(c.t), y);
        ctx.lineTo(X(c.t + agg), y);
        open = true;
      }
      ctx.stroke();
    };
    step('bestBid', 'rgba(52,211,153,0.55)', 0.5);
    step('bestAsk', 'rgba(248,113,113,0.55)', -0.5);

    // 3) PRICE LAYER (independent of the volume dots): true micro-OHLC candles from the raw exchange-time trades -
    //    open = first trade, high / low = extreme trades, close = last trade of each bucket; an empty bucket draws
    //    nothing. The bucket comes from real trade density and the visible range only (AUTO window, or the finest
    //    readable bucket after a zoom). A faint close trace holds the last traded price until the next real trade
    //    (horizontal / vertical only, never interpolated). Trade Agg and Volume Dots never touch this layer.
    const span = v.t1 - v.t0;
    const tr = this.trades();
    const pMs = this.autoSpan && this.autoWin ? this.autoWin.ms : priceBucketFor(tr, v.t0, v.t1, pw);
    const pBars = priceBars(tr, pMs, lowerBound(tr, v.t0 - pMs), upperBound(tr, v.t1 + pMs));
    const lNow = this.latest();
    const pSlot = (pMs / span) * pw;
    const geom: number[] = [pMs];
    const r2 = (x: number) => Math.round(x * 100) / 100;
    if (s.showPriceLine)
      for (const run of stepTrace(pBars, pMs, lNow ? Math.min(lNow.t, v.t1, (tr[tr.length - 1]?.t ?? -Infinity) + CATCH_UP_LAG_MS) : null)) {
        ctx.strokeStyle = 'rgba(203,213,225,0.32)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        run.forEach(([t, k], i) => {
          const x = X(t);
          const y = Y(k);
          geom.push(r2(x), r2(y));
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.stroke();
        geom.push(-1);
      }
    const bw = Math.max(1, Math.min(7, pSlot * 0.68));
    for (const b of pBars) {
      const x = Math.round(X(b.t + pMs / 2)) + 0.5;
      if (x < -bw || x > pw + bw) continue;
      const col = b.c > b.o ? 'rgba(34,197,94,0.95)' : b.c < b.o ? 'rgba(239,68,68,0.95)' : 'rgba(203,213,225,0.85)';
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1;
      const yh = Y(b.h) - 1;
      const yl = Y(b.l) + 1;
      ctx.beginPath(); // thin wick: actual high to actual low
      ctx.moveTo(x, yh);
      ctx.lineTo(x, yl);
      ctx.stroke();
      const yt = Y(Math.max(b.o, b.c));
      const yb = Y(Math.min(b.o, b.c));
      const bh = Math.max(2, yb - yt); // compact body: open-to-close (a flat candle is a 2 px dash)
      ctx.fillRect(x - bw / 2, (yt + yb) / 2 - bh / 2, bw, bh);
      geom.push(r2(x), r2(Y(b.h)), r2(Y(b.l)), r2(Y(b.o)), r2(Y(b.c)));
    }
    this.priceGeom = geom;
    this.lastPriceMs = pMs;
    // Diagnostics for verification (no data values): price bucket and number of real micro-candles in view.
    this.canvas.dataset.priceMs = String(pMs);
    this.canvas.dataset.candles = String(pBars.filter((b) => b.t + pMs >= v.t0 && b.t <= v.t1).length);

    // 4-pre) Volume-dot display bucket (Trade Agg): affects the bubbles ONLY.
    const choice = this.opts.dotAggregation?.() ?? 'auto';
    const ms = choice === 'auto' ? autoBucketMs(span, pw, tr, lowerBound(tr, v.t0), lowerBound(tr, v.t1 + 1)) : choice;
    this.lastBucketMs = ms;
    this.canvas.dataset.dotMs = String(ms);
    const bucketPx = (ms / span) * pw;
    const rowPx = ph / Math.max(1e-9, v.p1 - v.p0);

    // 4) Executed-volume dots: prints collapsed into display buckets (time bucket × price band sized so a band is
    //    about as tall as a bucket is wide) - one bubble per bucket at its VWAP, never a wall of circles. Radius:
    //    sqrt up to the robust p95 norm, then log, clamped to the cell. Colour from the dominant KNOWN side;
    //    weak dominance = MIXED, unknown >= known = UNKNOWN (never recoloured as a side).
    this.bubbles = [];
    if (s.showTrades && tr.length) {
      const band = bandTicksFor(bucketPx, rowPx);
      const dots = aggregateDots(tr, ms, band, lowerBound(tr, v.t0 - ms), lowerBound(tr, v.t1 + ms));
      const norm = quantileTotal(dots, 0.95);
      const cell = Math.max(bucketPx, band * rowPx);
      const fromTape = !!this.opts.tape;
      const order = dots.map((_, i) => i).sort((a, b) => dots[b]!.total - dots[a]!.total || a - b); // big under small
      for (const i of order) {
        const d = dots[i]!;
        if (!d.total) continue;
        const r = dotRadius(d.total, norm, cell);
        const x = X((d.first + d.last) / 2);
        const y = Y(d.vwapTick);
        if (x < -r || x > pw + r) continue;
        const dom = dominance(d);
        ctx.fillStyle = DOT_FILL[dom];
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        const ring = DOT_RING[dom];
        if (ring) {
          ctx.strokeStyle = ring;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        const ts = this.opts.tickSize;
        this.bubbles.push({
          x,
          y,
          r,
          h: { first: d.first, last: d.last, bucketMs: ms, price: d.vwapTick * ts, bandLo: d.band * ts, bandHi: (d.band + d.bandTicks - 1) * ts, count: fromTape ? d.count : null, buy: d.buy, sell: d.sell, unknown: d.unknown, total: d.total, dominant: dom },
        });
      }
    }
    // 3b) Current displayed depth at the right edge (latest VALID book only - genuine Level-2 levels, never inferred).
    const lastCol = cols[cols.length - 1];
    if (cellsOn && lastCol && lastCol.valid && lastCol.t + agg >= v.t0) {
      let maxSz = 0;
      for (const z of lastCol.bidSizes) maxSz = Math.max(maxSz, z);
      for (const z of lastCol.askSizes) maxSz = Math.max(maxSz, z);
      if (maxSz > 0) {
        const wMax = Math.min(140, pw * 0.12);
        const rowH = Math.max(1, ph / Math.max(1, v.p1 - v.p0) - 1);
        const bar = (ticks: Int32Array, sizes: Float64Array, color: string) => {
          ctx.fillStyle = color;
          for (let i = 0; i < ticks.length; i++) {
            const w = (sizes[i]! / maxSz) * wMax;
            ctx.fillRect(pw - w, Y(ticks[i]!) - rowH / 2, w, rowH);
          }
        };
        bar(lastCol.bidTicks, lastCol.bidSizes, 'rgba(34,197,94,0.75)');
        bar(lastCol.askTicks, lastCol.askSizes, 'rgba(239,68,68,0.75)');
      }
    }
    // 5) Highlighted event.
    if (this.highlight) {
      ctx.strokeStyle = '#efcd84';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(this.highlight.t), Y(this.highlight.tick), 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(X(this.highlight.t), 0);
      ctx.lineTo(X(this.highlight.t), ph);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 6) "Now" edge (latest exchange time) and the current-price guide.
    const l = this.latest();
    if (l) {
      ctx.strokeStyle = 'rgba(212,169,79,0.6)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(X(l.t + agg), 0);
      ctx.lineTo(X(l.t + agg), ph);
      ctx.stroke();
      if (l.tick !== null) {
        ctx.strokeStyle = 'rgba(212,169,79,0.45)';
        ctx.beginPath();
        ctx.moveTo(0, Y(l.tick));
        ctx.lineTo(pw, Y(l.tick));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.restore();
    this.axes(ctx, v, pw, ph, l?.tick ?? null);
  }

  private axes(ctx: CanvasRenderingContext2D, v: Viewport, pw: number, ph: number, cur: number | null): void {
    const d = this.opts.decimals;
    const ts = this.opts.tickSize;
    ctx.fillStyle = '#0a0f18';
    ctx.fillRect(pw, 0, AXIS_RIGHT, this.h);
    ctx.fillRect(0, ph, this.w, AXIS_BOTTOM);
    ctx.fillStyle = '#8b93a5';
    ctx.font = '11px "Inter Variable", Inter, system-ui, sans-serif';
    const Y = (tick: number) => ph - ((tick - v.p0) / (v.p1 - v.p0)) * ph;
    const span = v.p1 - v.p0;
    const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000];
    const stepT = nice.find((n) => (span / n) * 24 <= ph) ?? 10000;
    for (let t = Math.ceil(v.p0 / stepT) * stepT; t <= v.p1; t += stepT) ctx.fillText((t * ts).toFixed(d), pw + 6, Y(t) + 4);
    const tspan = v.t1 - v.t0;
    const tn = [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5];
    const stepX = tn.find((n) => (tspan / n) * 70 <= pw) ?? 72e5;
    for (let t = Math.ceil(v.t0 / stepX) * stepX; t <= v.t1; t += stepX) {
      const x = ((t - v.t0) / tspan) * pw;
      ctx.fillText(new Date(t).toLocaleTimeString('en-GB', { hour12: false }), x - 22, ph + 15);
    }
    if (cur !== null) {
      const y = Y(cur);
      ctx.fillStyle = '#d4a94f';
      ctx.fillRect(pw, y - 9, AXIS_RIGHT, 18);
      ctx.fillStyle = '#0a0f18';
      ctx.font = '700 11px "Inter Variable", Inter, system-ui, sans-serif';
      ctx.fillText((cur * ts).toFixed(d), pw + 6, y + 4);
    }
  }
}
