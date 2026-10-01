import type { ChartNavigable } from '../chart/ChartStage';
import { heatColor, intensityOf, isStrong, strongRunCells, type MapCell, type MapColumn, type MapResult, type StrongParams } from './liquidityMap';

/* ============================================================================
 * GC Liquidity Map canvas (this page only). Draws, from data it is handed and never alters:
 *   - recorded IBKR liquidity as 1-tick rectangles: width = the bucket's recorded-valid TIME, colour = DISPLAYED SIZE
 *     intensity (never a side / direction / signal), only inside recorded-valid time; depth gaps are hatched;
 *   - real Databento candles (narrow), the current price line + tag;
 *   - a CURRENT DEPTH profile column from the live visible IBKR book only (bid / ask distinct);
 *   - compact labels for strong levels that are displayed NOW.
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
  version: number;
}
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
/** CURRENT DEPTH column share of the drawing width (the chart keeps ~84 %). */
export const PROFILE_SHARE = 0.16;
export const DEFAULT_SPAN_MS = 6 * 3600_000;
const DEFAULT_TICKS = 260;
const ZOOM = 1.25;
const FONT = '"Inter Variable", Inter, system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';
const BG = '#060a12';

type Raf = { request(cb: () => void): number; cancel(id: number): void };
const defaultRaf = (): Raf =>
  typeof requestAnimationFrame === 'function' ? { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) } : { request: (cb) => setTimeout(cb, 50) as unknown as number, cancel: (id) => clearTimeout(id) };

export class LiquidityMapView implements ChartNavigable {
  vp: Viewport | null = null;
  follow = true;
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
  /** Per-column caches of the current analysis (mid tick, cells) - rebuilt when the analysis object changes. */
  private cacheFor: MapResult | null = null;
  private mids: (number | null)[] = [];
  private byCol: MapCell[][] = [];
  private strongFor: StrongParams | null = null;
  private strongSet = new Set<number>();
  private index(f: MapFrame): void {
    if (this.cacheFor !== f.result) {
      this.cacheFor = f.result;
      this.strongFor = null;
      this.mids = f.cols.map((_, i) => midTickOf(f, i));
      this.byCol = f.cols.map(() => []);
      for (const c of f.result?.cells ?? []) this.byCol[c.c]?.push(c);
    }
    if (this.strongFor !== f.strong) {
      this.strongFor = f.strong;
      this.strongSet = strongRunCells(f.result?.cells ?? [], this.mids, f.strong);
    }
  }

  constructor(
    private readonly host: HTMLElement,
    private readonly frame: () => MapFrame,
    private readonly opts: { tickSize: number; decimals: number; now?: () => number; raf?: Raf; onViewport?: (v: Viewport | null, plotPx: number) => void; onHover?: (h: HoverInfo | null) => void },
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
    if (emit) this.opts.onViewport?.(vp, this.plotW());
  }
  private centreTick(): number | null {
    const f = this.frame();
    if (f.lastPriceTick !== null) return f.lastPriceTick;
    const c = f.candles[f.candles.length - 1];
    return c ? Math.round(c.c / this.opts.tickSize) : null;
  }
  resetView(): void {
    this.follow = true;
    this.autoPrice = true;
    const c = this.centreTick();
    if (c === null) return this.set(null);
    const t1 = this.now() + lookAhead(DEFAULT_SPAN_MS);
    this.set({ t0: t1 - DEFAULT_SPAN_MS, t1, p0: c - DEFAULT_TICKS / 2, p1: c + DEFAULT_TICKS / 2 });
  }
  fitView(): void {
    this.resetView();
  }
  /** Fix the view to a window (no live following until reset). View state only. */
  pin(vp: Viewport): void {
    this.follow = false;
    this.autoPrice = false;
    this.set({ ...vp });
  }
  zoomIn(): void {
    if (!this.vp) this.resetView();
    this.zoomTime(1 / ZOOM, null);
  }
  zoomOut(): void {
    if (!this.vp) this.resetView();
    this.zoomTime(ZOOM, null);
  }
  private zoomTime(f: number, anchor: number | null): void {
    const v = this.vp;
    if (!v) return;
    const span = v.t1 - v.t0;
    const next = Math.min(Math.max(span * f, 5 * 60_000), 10 * 86_400_000);
    const a = anchor ?? (this.follow ? v.t1 : (v.t0 + v.t1) / 2);
    const k = (a - v.t0) / span;
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
  /** Auto price range: candles of the window (display only). */
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
    if (!this.vp) this.resetView();
    if (this.vp && this.follow) {
      const t1 = this.now() + lookAhead(this.vp.t1 - this.vp.t0);
      if (Math.abs(t1 - this.vp.t1) > 1000) this.set({ ...this.vp, t0: this.vp.t0 + (t1 - this.vp.t1), t1 }, false);
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
    if (!r) return;
    const v = this.vp!;
    const rowPx = Math.max(1, this.plotH() / (v.p1 - v.p0));
    for (let ci = 0; ci < r.cells.length; ci++) {
      const cell = r.cells[ci]!;
      const col = f.cols[cell.c]!;
      if (col.t + col.w < v.t0 || col.t > v.t1 || cell.tick < v.p0 - 1 || cell.tick > v.p1 + 1) continue;
      if (f.strongOnly && !this.strongSet.has(ci)) continue;
      const i = intensityOf(cell.size, r.refSize, f.gain);
      if (i <= 0.02) continue;
      const [cr, cg, cb] = heatColor(i);
      const y0 = this.y(cell.tick + 0.5);
      const hh = Math.max(1, rowPx);
      for (let k = 0; k < col.valid.length; k += 2) {
        const x0 = this.x(col.valid[k]!);
        const x1 = this.x(col.valid[k + 1]!);
        const ww = Math.max(0.6, x1 - x0);
        g.fillStyle = `rgba(${cr},${cg},${cb},${(0.06 + 0.94 * Math.pow(i, 1.3)).toFixed(3)})`;
        g.fillRect(x0, y0, ww, hh);
        if (i >= 0.93 && hh >= 3) {
          g.fillStyle = 'rgba(255,255,255,0.75)'; // white-hot centre of an exceptional wall
          g.fillRect(x0, y0 + hh * 0.35, ww, Math.max(1, hh * 0.3));
        }
      }
    }
  }

  /** Time with no recorded-valid depth (inside the window, up to now): hatched, never painted as liquidity. */
  private drawGaps(g: CanvasRenderingContext2D, f: MapFrame, H: number): void {
    const v = this.vp!;
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
    g.strokeStyle = 'rgba(226,232,240,0.6)';
    g.setLineDash([5, 4]);
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
    g.fillStyle = '#f1f5f9';
    g.fillRect(x, y - 10, AXIS_RIGHT, 20);
    g.fillStyle = BG;
    g.font = `700 11px ${MONO}`;
    g.textBaseline = 'middle';
    g.fillText((p * this.opts.tickSize).toFixed(this.opts.decimals), x + 5, y);
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
    const bar = (r: DepthRow, color: string) => {
      const y = this.y(r.tick + 0.5);
      if (y > H || y + rowPx < 18) return;
      const len = ((pw - 12) * r.size) / max;
      g.fillStyle = color;
      g.fillRect(x0 + pw - 2 - len, y + 0.5, len, Math.max(1, rowPx - 1));
    };
    for (const r of b.asks) bar(r, 'rgba(244,63,94,0.85)');
    for (const r of b.bids) bar(r, 'rgba(16,185,129,0.85)');
  }

  /** Compact labels for strong levels displayed NOW (latest bucket, depth live): "4200.0  SIZE 384  4.8×  AGE 03:42". */
  private drawLabels(g: CanvasRenderingContext2D, f: MapFrame): void {
    const r = f.result;
    if (!r || !f.depthLive || !f.cols.length) return;
    const lastC = f.cols.length - 1;
    const mid = this.mids[lastC] ?? null;
    const now = (this.byCol[lastC] ?? []).filter((c) => isStrong(c, mid, f.strong)).sort((a, b) => b.size - a.size).slice(0, 8);
    const used: [number, number][] = [];
    for (const c of now) {
      const y = this.y(c.tick);
      if (y < 10 || y > this.plotH() - 10 || used.some(([a, b]) => y > a - 4 && y < b + 4)) continue;
      const text = `${(c.tick * this.opts.tickSize).toFixed(this.opts.decimals)}  SIZE ${fmtSize(c.size)}  ${c.relative.toFixed(1)}×  AGE ${fmtAge(c.observedMs)}`;
      g.font = `700 10.5px ${FONT}`;
      const w = g.measureText(text).width + 12;
      const x = 6;
      const [cr, cg, cb] = heatColor(intensityOf(c.size, r.refSize, f.gain));
      g.fillStyle = 'rgba(6,10,18,0.88)';
      g.fillRect(x, y - 9, w, 18);
      g.fillStyle = `rgb(${cr},${cg},${cb})`;
      g.fillRect(x, y - 9, 3, 18);
      g.fillStyle = '#e2e8f0';
      g.textBaseline = 'middle';
      g.fillText(text, x + 8, y);
      g.textBaseline = 'alphabetic';
      used.push([y - 9, y + 9]);
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
function midTickOf(f: MapFrame, ci: number): number | null {
  const c = f.cols[ci];
  if (!c) return null;
  let bb = -Infinity;
  let ba = Infinity;
  for (let i = 0; i < c.bidTicks.length; i++) if (c.bidSizes[i]! > 0) bb = Math.max(bb, c.bidTicks[i]!);
  for (let i = 0; i < c.askTicks.length; i++) if (c.askSizes[i]! > 0) ba = Math.min(ba, c.askTicks[i]!);
  return Number.isFinite(bb) && Number.isFinite(ba) ? (bb + ba) / 2 : null;
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
