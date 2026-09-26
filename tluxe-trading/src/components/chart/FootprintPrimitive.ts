import type { IChartApiBase, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time, UTCTimestamp } from 'lightweight-charts';
import { FP_TF_SECONDS } from '../../engines/volumeFootprint/config';
import type { FPCandle, FPRow } from '../../engines/volumeFootprint/types';
import type { FPRenderData } from '../volumeFootprint/fpView';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
type Ctx = CanvasRenderingContext2D;

const GREEN = '60,201,160';
const RED = '239,93,93';
const GOLD = '212,169,79';
const GREY = '138,147,163';
const FONT = '"Inter Variable", Inter, system-ui, sans-serif';

/** Level of detail from the zoom (never from the data): cells → numbers only when they are readable. */
export function detailLevel(barPx: number, rowPx: number, density: FPRenderData['view']['density']): 'none' | 'cells' | 'single' | 'full' {
  const k = density === 'HIGH' ? 0.75 : density === 'LOW' ? 1.4 : 1;
  if (barPx < 18 * k || rowPx < 2) return 'none';
  if (rowPx < 7 * k || barPx < 34 * k) return 'cells';
  if (barPx < 76 * k) return 'single';
  return 'full';
}

const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '-' : ''}${short(Math.abs(x))}`;
const short = (v: number) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));

class Renderer implements IPrimitivePaneRenderer {
  constructor(private readonly src: FootprintPrimitive) {}
  draw(target: Target): void {
    const { chart, series, data } = this.src;
    if (!chart || !series || !data || !data.candles.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = chart.timeScale();
      const bar = ts.options().barSpacing;
      const range = ts.getVisibleRange();
      const from = range ? Number(range.from) : -Infinity;
      const to = range ? Number(range.to) : Infinity;
      const yOf = (p: number) => series.priceToCoordinate(p);
      const t = data.toggles;
      const v = data.view;
      const y0 = yOf(data.candles[data.candles.length - 1]!.close);
      const y1 = yOf(data.candles[data.candles.length - 1]!.close + data.rowSize);
      const rowPx = y0 === null || y1 === null ? 0 : Math.abs(y0 - y1);
      const lod = detailLevel(bar, rowPx, v.density);
      const visible = data.candles.filter((c) => c.time >= from - 1 && c.time <= to + 1);
      // Stacked imbalance zones (engine stacks) extend right from their candle.
      if (t.stacked)
        for (const s of data.stacks) {
          if (s.state === 'CONSUMED') continue;
          const x = ts.timeToCoordinate((s.time - FP_TF_SECONDS[s.tf]) as UTCTimestamp);
          const ya = yOf(s.high + data.rowSize);
          const yb = yOf(s.low);
          if (x === null || ya === null || yb === null) continue;
          ctx.fillStyle = `rgba(${s.side === 'BUY' ? GREEN : RED},0.08)`;
          ctx.fillRect(x, Math.min(ya, yb), mediaSize.width - x, Math.abs(yb - ya));
        }
      for (const line of data.lines) {
        const ya = yOf(line.high);
        const yb = yOf(line.low);
        if (ya === null || yb === null) continue;
        ctx.strokeStyle = line.color;
        ctx.fillStyle = line.color;
        if (line.kind === 'zone') {
          ctx.globalAlpha = 0.09;
          ctx.fillRect(0, Math.min(ya, yb), mediaSize.width, Math.max(2, Math.abs(yb - ya)));
          ctx.globalAlpha = 1;
        } else {
          ctx.setLineDash(line.dashed ? [5, 4] : []);
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          ctx.moveTo(0, Math.round(ya) + 0.5);
          ctx.lineTo(mediaSize.width, Math.round(ya) + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        ctx.font = `600 9.5px ${FONT}`;
        ctx.fillText(line.label, 6, Math.min(ya, yb) - 3);
      }
      if (lod === 'none') {
        for (const c of visible) {
          this.simpleCandle(ctx, c, bar);
          if (t.poc) this.pocTick(ctx, c, bar, data.rowSize);
        }
      } else for (const c of visible) this.candle(ctx, c, bar, lod, data);
      if (t.cvd && data.cvd.length > 1) this.cvd(ctx, mediaSize, data, from, to);
    });
  }

  /** Zoomed out: a plain candle (the series' own candles are hidden on the footprint chart). */
  private simpleCandle(ctx: Ctx, c: FPCandle, bar: number): void {
    const { chart, series } = this.src;
    const x = chart!.timeScale().timeToCoordinate(c.time as UTCTimestamp);
    const yh = series!.priceToCoordinate(c.high);
    const yl = series!.priceToCoordinate(c.low);
    const yo = series!.priceToCoordinate(c.open);
    const yc = series!.priceToCoordinate(c.close);
    if (x === null || yh === null || yl === null || yo === null || yc === null) return;
    const col = c.close >= c.open ? GREEN : RED;
    ctx.fillStyle = `rgba(${col},1)`;
    ctx.fillRect(Math.round(x), Math.min(yh, yl), 1, Math.max(1, Math.abs(yl - yh)));
    const w = Math.max(1, bar * 0.7);
    ctx.fillRect(x - w / 2, Math.min(yo, yc), w, Math.max(1, Math.abs(yc - yo)));
  }

  private pocTick(ctx: Ctx, c: FPCandle, bar: number, rowSize: number): void {
    const { chart, series } = this.src;
    const x = chart!.timeScale().timeToCoordinate(c.time as UTCTimestamp);
    const y = series!.priceToCoordinate(c.poc + rowSize / 2);
    if (x === null || y === null) return;
    ctx.fillStyle = `rgba(${GOLD},0.95)`;
    ctx.fillRect(x - Math.max(2, bar * 0.45), y - 1, Math.max(4, bar * 0.9), 2);
  }

  private candle(ctx: Ctx, c: FPCandle, bar: number, lod: 'cells' | 'single' | 'full', d: FPRenderData): void {
    const { chart, series } = this.src;
    const x = chart!.timeScale().timeToCoordinate(c.time as UTCTimestamp);
    if (x === null) return;
    const w = bar * 0.9;
    const left = x - w / 2;
    const t = d.toggles;
    const v = d.view;
    let rows: FPRow[] = c.rows;
    if (v.showZero && rows.length > 1) {
      const have = new Map(rows.map((r) => [Math.round(r.price / d.rowSize), r]));
      const hi = Math.round(rows[0]!.price / d.rowSize);
      const lo = Math.round(rows[rows.length - 1]!.price / d.rowSize);
      rows = [];
      for (let k = hi; k >= lo; k--) rows.push(have.get(k) ?? { price: Number((k * d.rowSize).toFixed(d.decimals)), bid: 0, ask: 0, unknown: 0, total: 0, delta: 0, buyImb: false, sellImb: false, buyRatio: null, sellRatio: null });
    }
    let maxSide = 1;
    let maxTot = 1;
    let maxAbsDelta = 1;
    for (const r of c.rows) {
      maxSide = Math.max(maxSide, r.bid, r.ask);
      maxTot = Math.max(maxTot, r.total);
      maxAbsDelta = Math.max(maxAbsDelta, Math.abs(r.delta));
    }
    const scale = (a: number, m: number) => (v.cellScale === 'SQRT' ? Math.sqrt(a / m) : a / m);
    const ohlcW = 3;
    const cellL = left + ohlcW + 2;
    const cellW = w - ohlcW - 2;
    for (const r of rows) {
      const ya = series!.priceToCoordinate(r.price + d.rowSize);
      const yb = series!.priceToCoordinate(r.price);
      if (ya === null || yb === null) continue;
      const top = Math.min(ya, yb) + 0.5;
      const h = Math.max(1, Math.abs(yb - ya) - 1);
      // Cell background by mode (engine numbers only).
      const m = v.mode;
      if (m === 'BID_ASK' || m === 'IMBALANCE') {
        ctx.fillStyle = `rgba(${RED},${0.08 + 0.5 * scale(r.bid, maxSide)})`;
        ctx.fillRect(cellL, top, cellW / 2, h);
        ctx.fillStyle = `rgba(${GREEN},${0.08 + 0.5 * scale(r.ask, maxSide)})`;
        ctx.fillRect(cellL + cellW / 2, top, cellW / 2, h);
      } else if (m === 'DELTA' || m === 'DELTA_IMBALANCE') {
        const a = 0.08 + 0.55 * scale(Math.abs(r.delta), maxAbsDelta);
        ctx.fillStyle = `rgba(${r.delta >= 0 ? GREEN : RED},${a})`;
        ctx.fillRect(cellL, top, cellW, h);
      } else {
        ctx.fillStyle = `rgba(${GOLD},${0.06 + 0.5 * scale(r.total, maxTot)})`;
        ctx.fillRect(cellL, top, (cellW * r.total) / maxTot || 1, h);
      }
      if (v.showUnknown && r.unknown > 0) {
        ctx.fillStyle = `rgba(${GREY},0.7)`;
        ctx.fillRect(cellL + cellW - 2, top, 2, h);
      }
      const showImb = m === 'IMBALANCE' || m === 'DELTA_IMBALANCE' || m === 'BID_ASK';
      if (showImb && ((t.buyImb && r.buyImb) || (t.sellImb && r.sellImb))) {
        ctx.strokeStyle = r.buyImb && t.buyImb ? `rgba(${GREEN},0.95)` : `rgba(${RED},0.95)`;
        ctx.lineWidth = 1.2;
        const half = r.buyImb && t.buyImb ? cellL + cellW / 2 : cellL;
        ctx.strokeRect(m === 'BID_ASK' ? half + 0.5 : cellL + 0.5, top + 0.5, (m === 'BID_ASK' ? cellW / 2 : cellW) - 1, h - 1);
      }
      if (t.poc && Math.abs(r.price - c.poc) < d.rowSize / 2) {
        ctx.strokeStyle = `rgba(${GOLD},1)`;
        ctx.lineWidth = 1.4;
        ctx.strokeRect(cellL + 0.5, top + 0.5, cellW - 1, h - 1);
      }
      if (lod === 'cells' || !t.bidAsk) continue;
      const fs = Math.max(6.5, Math.min(11, h));
      ctx.font = `600 ${fs}px ${FONT}`;
      ctx.textBaseline = 'middle';
      const cy = top + h / 2;
      if (lod === 'full' && (m === 'BID_ASK' || m === 'IMBALANCE')) {
        ctx.textAlign = 'right';
        ctx.fillStyle = r.sellImb && t.sellImb ? '#ffb4b4' : '#e3e6ec';
        ctx.fillText(short(r.bid), cellL + cellW / 2 - 6, cy);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#6b7383';
        ctx.fillText('×', cellL + cellW / 2, cy);
        ctx.textAlign = 'left';
        ctx.fillStyle = r.buyImb && t.buyImb ? '#a8f0d8' : '#e3e6ec';
        ctx.fillText(short(r.ask), cellL + cellW / 2 + 6, cy);
      } else {
        ctx.textAlign = 'center';
        const val = m === 'TOTAL' || m === 'VOLUME' ? short(r.total) : signed(r.delta);
        ctx.fillStyle = m === 'TOTAL' || m === 'VOLUME' ? '#e3e6ec' : Math.abs(r.delta) >= v.deltaHighlight ? (r.delta > 0 ? '#a8f0d8' : '#ffb4b4') : '#c6ccd6';
        ctx.fillText(val, cellL + cellW / 2, cy);
      }
    }
    // Thin OHLC bar at the left edge of the footprint (the candle itself).
    const yh = series!.priceToCoordinate(c.high + d.rowSize);
    const yl = series!.priceToCoordinate(c.low);
    const yo = series!.priceToCoordinate(c.open + d.rowSize / 2);
    const yc = series!.priceToCoordinate(c.close + d.rowSize / 2);
    if (yh !== null && yl !== null && yo !== null && yc !== null) {
      const col = c.close >= c.open ? GREEN : RED;
      ctx.fillStyle = `rgba(${col},0.55)`;
      ctx.fillRect(left + 1, Math.min(yh, yl), 1, Math.abs(yl - yh));
      ctx.fillStyle = `rgba(${col},1)`;
      ctx.fillRect(left, Math.min(yo, yc) - 1, ohlcW, Math.max(2, Math.abs(yc - yo)));
      if (d.selected === c.time) {
        ctx.strokeStyle = `rgba(${GOLD},0.9)`;
        ctx.lineWidth = 1;
        ctx.strokeRect(left - 2.5, Math.min(yh, yl) - 3.5, w + 5, Math.abs(yl - yh) + 7);
      }
      if (t.delta && lod !== 'cells') {
        ctx.font = `700 10px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = c.delta > 0 ? '#86e3c6' : c.delta < 0 ? '#f3a0a0' : '#8a93a3';
        ctx.fillText(`Δ ${c.delta > 0 ? '+' : ''}${c.delta}`, x, Math.max(yh, yl) + 5);
        if (c.unknown > 0 && d.view.showUnknown) {
          ctx.fillStyle = '#8a93a3';
          ctx.fillText(`? ${c.unknown}`, x, Math.max(yh, yl) + 17);
        }
      }
    }
  }

  private cvd(ctx: Ctx, size: { width: number; height: number }, d: FPRenderData, from: number, to: number): void {
    const ts = this.src.chart!.timeScale();
    const pts = d.cvd.filter((p) => p.time >= from - 1 && p.time <= to + 1);
    if (pts.length < 2) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      lo = Math.min(lo, p.value);
      hi = Math.max(hi, p.value);
    }
    const band = size.height * 0.14;
    const base = size.height - 4;
    const yOf = (val: number) => base - (hi === lo ? band / 2 : ((val - lo) / (hi - lo)) * band);
    ctx.strokeStyle = 'rgba(91,140,255,0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let first = true;
    for (const p of pts) {
      const x = ts.timeToCoordinate(p.time as UTCTimestamp);
      if (x === null) continue;
      if (first) ctx.moveTo(x, yOf(p.value));
      else ctx.lineTo(x, yOf(p.value));
      first = false;
    }
    ctx.stroke();
    ctx.font = `600 9.5px ${FONT}`;
    ctx.fillStyle = '#a9c1ff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`CVD ${pts[pts.length - 1]!.value > 0 ? '+' : ''}${pts[pts.length - 1]!.value}`, 6, base - band - 4);
  }
}

class View implements IPrimitivePaneView {
  private readonly r: Renderer;
  constructor(src: FootprintPrimitive) {
    this.r = new Renderer(src);
  }
  zOrder() {
    return 'top' as const;
  }
  renderer() {
    return this.r;
  }
}

/** Series primitive for the Volume Footprint page: draws ENGINE footprint rows only (no invented cells). */
export class FootprintPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApiBase<Time> | null = null;
  series: ISeriesApi<SeriesType, Time> | null = null;
  data: FPRenderData | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[] = [new View(this)];
  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
  set(data: FPRenderData | null): void {
    this.data = data;
    this.requestUpdate?.();
  }
}
