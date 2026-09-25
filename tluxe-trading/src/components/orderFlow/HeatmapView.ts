import type { HeatmapViewSettings } from '../../engines/orderFlow/config';
import type { HeatmapColumn, OrderFlowEngine } from '../../engines/orderFlow/engine';
import type { ChartNavigable } from '../chart/ChartStage';
import { bounds, colorAt, columnRows, intensity, smooth, type Viewport } from './heatmapMath';

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
const ZOOM = 1.25;

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
}

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

  constructor(
    private readonly host: HTMLElement,
    private readonly source: () => OrderFlowEngine | null,
    private readonly opts: HeatmapViewOptions,
  ) {
    this.raf = opts.raf ?? defaultRaf();
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
  private latest(): { t: number; tick: number | null } | null {
    const e = this.source();
    if (!e) return null;
    const cols = e.allColumns();
    const last = cols[cols.length - 1];
    if (!last) return null;
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
    this.set({ t0: t1 - DEFAULT_SPAN_COLUMNS * agg, t1, p0: c - DEFAULT_PRICE_TICKS / 2, p1: c + DEFAULT_PRICE_TICKS / 2 });
    this.emitViewport(true);
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
    if (!Number.isFinite(lo)) return this.resetView();
    const agg = this.agg();
    this.follow = true;
    this.autoPrice = false;
    this.set({ t0: cols[0]!.t, t1: cols[cols.length - 1]!.t + 2 * agg, p0: lo - 2, p1: hi + 3 });
    this.emitViewport(true);
  }
  private zoomTime(f: number, anchor: number | null): void {
    const v = this.vp;
    if (!v) return;
    const span = v.t1 - v.t0;
    const agg = this.agg();
    const next = Math.min(Math.max(span * f, 10 * agg), 20_000 * agg);
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
    if (!this.pointers.has(e.pointerId)) return;
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

  /* ------------------------------- drawing ------------------------------- */

  private loop = () => {
    if (this.destroyed) return;
    const e = this.source();
    const ver = e?.version ?? -1;
    if (ver !== this.lastVersion) {
      this.lastVersion = ver;
      this.dirty = true;
      if (!this.vp && e && e.allColumns().length) this.resetView();
    }
    if (this.dirty && this.vp) {
      const l = this.latest();
      const agg = this.agg();
      if (this.follow && l) {
        const span = this.vp.t1 - this.vp.t0;
        this.vp = { ...this.vp, t1: l.t + 2 * agg, t0: l.t + 2 * agg - span };
      }
      if (this.autoPrice && l && l.tick !== null) {
        const half = (this.vp.p1 - this.vp.p0) / 2;
        this.vp = { ...this.vp, p0: l.tick - half, p1: l.tick + half };
      }
    }
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
    this.frameId = this.raf.request(this.loop);
  };

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

    // 1) Liquidity cells (one ImageData pixel per column × price row, scaled up without smoothing).
    const pAgg = Math.max(1, Math.round(s.priceAggregation), Math.ceil((v.p1 - v.p0) / Math.max(1, ph)));
    const base = Math.floor(v.p0 / pAgg) * pAgg;
    const rows = Math.max(1, Math.ceil((v.p1 - base) / pAgg) + 1);
    if (vis.length) {
      const { lo, hi } = bounds(cols, s, vis);
      if (!this.off) this.off = document.createElement('canvas');
      this.off.width = vis.length;
      this.off.height = rows;
      const octx = this.off.getContext('2d');
      if (octx) {
        const img = octx.createImageData(vis.length, rows);
        const bg = colorAt(0, s.colorScheme);
        vis.forEach((c, i) => {
          const vals = c.valid ? smooth(columnRows(c, base, rows, pAgg), s.smoothing) : null;
          for (let r = 0; r < rows; r++) {
            const o = ((rows - 1 - r) * vis.length + i) * 4;
            let rgb: [number, number, number];
            if (!vals) rgb = r % 4 < 2 ? [34, 38, 48] : [26, 29, 38]; // NO DATA hatch — never inferred
            else {
              const x = intensity(vals[r]!, lo, hi, s.contrast, s.minDepth);
              rgb = x > 0 ? colorAt(x, s.colorScheme) : bg;
            }
            img.data[o] = rgb[0];
            img.data[o + 1] = rgb[1];
            img.data[o + 2] = rgb[2];
            img.data[o + 3] = 255;
          }
        });
        octx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        const x0 = X(vis[0]!.t);
        const x1 = X(vis[vis.length - 1]!.t + agg);
        ctx.drawImage(this.off, 0, 0, vis.length, rows, x0, Y(base + rows * pAgg), x1 - x0, Y(base) - Y(base + rows * pAgg));
      }
    }
    const cw = (agg / (v.t1 - v.t0)) * pw;

    // 2) Best bid / ask steps and the last-trade price line.
    const step = (key: 'bestBid' | 'bestAsk' | 'lastTick', color: string, width: number, off: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      let open = false;
      for (const c of vis) {
        const tk = c[key];
        if (tk === null || (key !== 'lastTick' && !c.valid)) {
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
    step('bestBid', 'rgba(52,211,153,0.55)', 1, 0.5);
    step('bestAsk', 'rgba(248,113,113,0.55)', 1, -0.5);
    if (s.showPriceLine) step('lastTick', 'rgba(255,255,255,0.9)', 1.4, 0);

    // 3) Executed trades: bubble area ∝ size; colour only from the provider's aggressor (UNKNOWN grey).
    if (s.showTrades) {
      let max = 0;
      for (const c of vis) for (const t of c.trades) max = Math.max(max, t.buy, t.sell, t.unknown);
      if (max > 0)
        for (const c of vis)
          for (const t of c.trades)
            for (const [vol, color] of [
              [t.buy, 'rgba(34,197,94,0.85)'],
              [t.sell, 'rgba(239,68,68,0.85)'],
              [t.unknown, 'rgba(156,163,175,0.8)'],
            ] as [number, string][]) {
              if (!vol) continue;
              const r = 1.5 + 13 * Math.sqrt(vol / max);
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(X(c.t) + cw / 2, Y(t.tick), r, 0, Math.PI * 2);
              ctx.fill();
            }
    }
    // 4) Highlighted event.
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
    // 5) "Now" edge (latest exchange time).
    const l = this.latest();
    if (l) {
      ctx.strokeStyle = 'rgba(212,169,79,0.6)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(X(l.t + agg), 0);
      ctx.lineTo(X(l.t + agg), ph);
      ctx.stroke();
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
