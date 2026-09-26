import type { IChartApiBase, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesAttachedParameter, SeriesType, Time, UTCTimestamp } from 'lightweight-charts';
import type { VPDrawable, VPHistogram } from '../volumeProfile/vpView';
import { layoutLabels } from './labelLayout';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
const TONE: Record<VPDrawable['tone'], { rgb: string; text: string }> = {
  poc: { rgb: '239,93,93', text: '#f3a0a0' },
  va: { rgb: '91,140,255', text: '#a9c1ff' },
  prev: { rgb: '154,163,178', text: '#c6ccd6' },
  hvn: { rgb: '212,169,79', text: '#efcd84' },
  lvn: { rgb: '167,139,250', text: '#cdbdfd' },
  bull: { rgb: '60,201,160', text: '#86e3c6' },
  bear: { rgb: '239,93,93', text: '#f3a0a0' },
  liq: { rgb: '138,180,248', text: '#b9d2fb' },
  sr: { rgb: '212,169,79', text: '#efcd84' },
  session: { rgb: '154,163,178', text: '#c6ccd6' },
};
const LABEL_H = 17;
const PAD = 6;

class Renderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly src: VolumeProfilePrimitive,
    private readonly layer: 'shapes' | 'labels',
  ) {}
  draw(target: Target): void {
    const { chart, series, items, hist } = this.src;
    if (!chart || !series) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = chart.timeScale();
      const xOf = (t: number | null, fb: number) => {
        if (t === null) return fb;
        const idx = ts.timeToIndex(t as UTCTimestamp, true);
        const x = idx === null ? null : ts.logicalToCoordinate(idx as unknown as Logical);
        return x ?? fb;
      };
      if (this.layer === 'shapes') {
        // Horizontal histogram at the right edge (engine rows only).
        if (hist && hist.rows.length && hist.max > 0) {
          const maxW = Math.min(220, mediaSize.width * 0.28);
          for (const r of hist.rows) {
            const y1 = series.priceToCoordinate(r.price);
            const y2 = series.priceToCoordinate(r.price + hist.binSize);
            if (y1 === null || y2 === null) continue;
            const top = Math.min(y1, y2);
            const h = Math.max(1, Math.abs(y2 - y1) - 0.5);
            if (top > mediaSize.height || top + h < 0 || r.volume <= 0) continue;
            const w = (r.volume / hist.max) * maxW;
            const isPoc = hist.poc !== null && r.price <= hist.poc && hist.poc < r.price + hist.binSize;
            const inVa = hist.val !== null && hist.vah !== null && r.price >= hist.val - 1e-9 && r.price + hist.binSize <= hist.vah + 1e-9;
            ctx.fillStyle = isPoc ? 'rgba(239,93,93,0.85)' : inVa ? 'rgba(91,140,255,0.55)' : 'rgba(229,163,59,0.35)';
            ctx.fillRect(mediaSize.width - w, top, w, h);
          }
        }
        for (const it of items) {
          const c = TONE[it.tone];
          const yA = series.priceToCoordinate(it.high);
          const yB = series.priceToCoordinate(it.low);
          if (yA === null || yB === null) continue;
          const x0 = Math.max(0, xOf(it.from, 0));
          const x1 = Math.min(mediaSize.width, it.to === null ? mediaSize.width : xOf(it.to, mediaSize.width));
          if (it.kind === 'zone') {
            ctx.fillStyle = `rgba(${c.rgb},0.1)`;
            ctx.fillRect(x0, Math.min(yA, yB), Math.max(1, x1 - x0), Math.max(2, Math.abs(yB - yA)));
            continue;
          }
          const y = Math.round(yA) + 0.5;
          ctx.strokeStyle = `rgba(${c.rgb},${it.emphasis ? 0.95 : 0.65})`;
          ctx.lineWidth = it.emphasis ? 1.8 : 1;
          ctx.setLineDash(it.dashed ? [6, 4] : []);
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(Math.max(x0 + 1, x1), y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        return;
      }
      ctx.font = '700 10.5px "Inter Variable", Inter, system-ui, sans-serif';
      const rows = items
        .filter((i) => i.label)
        .map((i) => ({ i, y: (series.priceToCoordinate(i.high) ?? -999) }))
        .filter((r) => r.y > -100 && r.y < mediaSize.height + 100);
      const placed = layoutLabels(rows.map((r) => ({ id: r.i.id, y: r.y, height: LABEL_H, priority: r.i.emphasis ? 0 : 2 })), mediaSize.height);
      const maxW = hist && hist.rows.length ? Math.min(220, mediaSize.width * 0.28) : 0;
      for (const p of placed) {
        const r = rows.find((x) => x.i.id === p.id)!;
        const c = TONE[r.i.tone];
        const w = ctx.measureText(r.i.label).width + 2 * PAD;
        const x = Math.max(4, mediaSize.width - maxW - w - 10);
        ctx.fillStyle = 'rgba(10,14,20,0.9)';
        ctx.strokeStyle = `rgba(${c.rgb},${r.i.emphasis ? 0.95 : 0.55})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x + 0.5, p.top + 0.5, w, LABEL_H, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = c.text;
        ctx.fillText(r.i.label, x + PAD, p.top + 12.5);
      }
    });
  }
}
class View implements IPrimitivePaneView {
  private readonly r: Renderer;
  constructor(
    src: VolumeProfilePrimitive,
    private readonly layer: 'shapes' | 'labels',
  ) {
    this.r = new Renderer(src, layer);
  }
  zOrder() {
    return this.layer === 'shapes' ? ('bottom' as const) : ('top' as const);
  }
  renderer() {
    return this.r;
  }
}

/** Series primitive for the Volume Profile page (engine rows / levels only — nothing decorative). */
export class VolumeProfilePrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApiBase<Time> | null = null;
  series: ISeriesApi<SeriesType, Time> | null = null;
  items: VPDrawable[] = [];
  hist: VPHistogram | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[] = [new View(this, 'shapes'), new View(this, 'labels')];
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
  set(hist: VPHistogram | null, items: VPDrawable[]): void {
    this.hist = hist;
    this.items = items;
    this.requestUpdate?.();
  }
}
