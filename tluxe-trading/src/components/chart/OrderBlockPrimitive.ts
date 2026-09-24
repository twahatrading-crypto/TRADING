import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { OBDrawable } from '../orderBlocks/obView';
import { layoutLabels } from './labelLayout';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** Restrained green (bullish) / red (bearish) zones. */
const COLORS = {
  bullish: { fill: '63,207,124', text: '#8fe0b0' },
  bearish: { fill: '239,93,93', text: '#f3a0a0' },
};
const LABEL_H = 30;
const LABEL_H_COMPACT = 18;
const PAD = 8;
const COMPACT = 560;

class Renderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly src: OrderBlockPrimitive,
    private readonly layer: 'zones' | 'labels',
  ) {}

  draw(target: Target): void {
    const { chart, series, items } = this.src;
    if (!chart || !series || items.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = chart.timeScale();
      const xOf = (t: number | null, fallback: number) => {
        if (t === null) return fallback;
        const idx = ts.timeToIndex(t as UTCTimestamp, true);
        const x = idx === null ? null : ts.logicalToCoordinate(idx as unknown as Logical);
        return x ?? fallback;
      };
      const rows = items
        .map((d) => {
          const yTop = series.priceToCoordinate(d.high);
          const yBot = series.priceToCoordinate(d.low);
          if (yTop === null || yBot === null) return null;
          const x0 = Math.max(0, xOf(d.from, 0));
          const x1 = Math.min(mediaSize.width, d.to === null ? mediaSize.width : xOf(d.to, mediaSize.width));
          const top = Math.min(yTop, yBot);
          const h = Math.max(2, Math.abs(yBot - yTop));
          return { d, x0, x1, top, h, y: top + h / 2 };
        })
        .filter((r): r is NonNullable<typeof r> => !!r && r.top < mediaSize.height && r.top + r.h > 0 && r.x1 > r.x0);

      if (this.layer === 'zones') {
        for (const r of [...rows].sort((a, b) => Number(a.d.selected) - Number(b.d.selected) || a.d.emphasis - b.d.emphasis)) {
          const c = COLORS[r.d.type];
          const strong = r.d.selected || r.d.highlighted;
          ctx.fillStyle = `rgba(${c.fill},${r.d.spent ? 0.05 : strong ? 0.2 : 0.07 + 0.07 * r.d.emphasis})`;
          ctx.fillRect(r.x0, r.top, r.x1 - r.x0, r.h);
          ctx.strokeStyle = `rgba(${c.fill},${r.d.spent ? 0.3 : strong ? 0.95 : 0.4 + 0.3 * r.d.emphasis})`;
          ctx.lineWidth = strong ? 1.5 : 1;
          ctx.setLineDash(r.d.spent ? [3, 4] : []);
          ctx.strokeRect(Math.round(r.x0) + 0.5, Math.round(r.top) + 0.5, Math.max(1, Math.round(r.x1 - r.x0) - 1), Math.max(1, Math.round(r.h) - 1));
          ctx.setLineDash([]);
        }
        return;
      }

      const compact = mediaSize.width < COMPACT;
      const lh = compact ? LABEL_H_COMPACT : LABEL_H;
      ctx.font = '700 11px "Inter Variable", Inter, system-ui, sans-serif';
      const width = new Map(rows.map((r) => [r.d.id, (compact ? ctx.measureText(r.d.label).width : Math.max(ctx.measureText(r.d.label).width, ctx.measureText(r.d.sublabel).width * 0.9)) + 2 * PAD]));
      const placed = layoutLabels(
        rows.map((r) => ({ id: r.d.id, y: r.y, height: lh, priority: r.d.selected ? 0 : r.d.highlighted ? 1 : 2 + (1 - r.d.emphasis) + (r.d.spent ? 1 : 0) })),
        mediaSize.height,
      );
      for (const p of placed) {
        const r = rows.find((x) => x.d.id === p.id)!;
        const w = width.get(p.id)!;
        const x = mediaSize.width - w - 10;
        const c = COLORS[r.d.type];
        ctx.globalAlpha = r.d.spent && !r.d.selected ? 0.75 : 1;
        ctx.fillStyle = 'rgba(10,14,20,0.92)';
        ctx.strokeStyle = `rgba(${c.fill},${r.d.selected || r.d.highlighted ? 0.95 : 0.5})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x + 0.5, p.top + 0.5, w, lh, 4);
        ctx.fill();
        ctx.stroke();
        if (r.y < p.top || r.y > p.top + lh) {
          ctx.beginPath();
          ctx.moveTo(x, p.top + lh / 2);
          ctx.lineTo(x - 8, r.y);
          ctx.stroke();
        }
        ctx.fillStyle = c.text;
        ctx.font = '700 11px "Inter Variable", Inter, system-ui, sans-serif';
        ctx.fillText(r.d.label, x + PAD, p.top + 13);
        if (!compact) {
          ctx.fillStyle = '#9aa3b2';
          ctx.font = '500 10px "Inter Variable", Inter, system-ui, sans-serif';
          ctx.fillText(r.d.sublabel, x + PAD, p.top + 25);
        }
        ctx.globalAlpha = 1;
      }
    });
  }
}

class View implements IPrimitivePaneView {
  private readonly r: Renderer;
  constructor(
    src: OrderBlockPrimitive,
    private readonly layer: 'zones' | 'labels',
  ) {
    this.r = new Renderer(src, layer);
  }
  zOrder() {
    return this.layer === 'zones' ? ('bottom' as const) : ('top' as const);
  }
  renderer() {
    return this.r;
  }
}

/** Series primitive that draws Order Block zones (engine output prepared by the UI). */
export class OrderBlockPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApiBase<Time> | null = null;
  series: ISeriesApi<SeriesType, Time> | null = null;
  items: OBDrawable[] = [];
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[] = [new View(this, 'zones'), new View(this, 'labels')];

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
  setItems(items: OBDrawable[]): void {
    this.items = items;
    this.requestUpdate?.();
  }
}
