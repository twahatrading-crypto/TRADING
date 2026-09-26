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
import type { SmcDrawable } from '../smc/smcView';
import { layoutLabels } from './labelLayout';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

const TONE: Record<SmcDrawable['tone'], { rgb: string; text: string; fill: number }> = {
  bull: { rgb: '60,201,160', text: '#86e3c6', fill: 0.14 },
  bear: { rgb: '239,93,93', text: '#f3a0a0', fill: 0.14 },
  fvgBull: { rgb: '91,140,255', text: '#a9c1ff', fill: 0.14 },
  fvgBear: { rgb: '167,139,250', text: '#cdbdfd', fill: 0.14 },
  structure: { rgb: '212,169,79', text: '#efcd84', fill: 0 },
  liquidity: { rgb: '138,180,248', text: '#b9d2fb', fill: 0 },
  premium: { rgb: '239,93,93', text: '#f3a0a0', fill: 0.05 },
  discount: { rgb: '60,201,160', text: '#86e3c6', fill: 0.05 },
  eq: { rgb: '154,163,178', text: '#c6ccd6', fill: 0 },
  gold: { rgb: '212,169,79', text: '#efcd84', fill: 0.08 },
  muted: { rgb: '138,147,163', text: '#9aa3b2', fill: 0.06 },
};
const LABEL_H = 17;
const PAD = 6;

class Renderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly src: SmcPrimitive,
    private readonly layer: 'shapes' | 'labels',
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
          return { d, x0, x1, top, h: Math.abs(yBot - yTop), y: (yTop + yBot) / 2 };
        })
        .filter((r): r is NonNullable<typeof r> => !!r && r.top < mediaSize.height + 40 && r.top + r.h > -40);

      if (this.layer === 'shapes') {
        for (const r of rows) {
          const c = TONE[r.d.tone];
          if (r.d.kind === 'path' && r.d.points?.length) {
            ctx.strokeStyle = `rgba(${c.rgb},0.75)`;
            ctx.lineWidth = 1.2;
            ctx.setLineDash([]);
            ctx.beginPath();
            let started = false;
            for (const p of r.d.points) {
              const y = series.priceToCoordinate(p.p);
              if (y === null) continue;
              const x = xOf(p.t, -1);
              if (x < 0) continue;
              if (!started) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
              started = true;
            }
            ctx.stroke();
            continue;
          }
          if (r.d.kind === 'zone') {
            ctx.fillStyle = `rgba(${c.rgb},${c.fill || 0.1})`;
            ctx.fillRect(r.x0, r.top, Math.max(1, r.x1 - r.x0), Math.max(2, r.h));
            ctx.strokeStyle = `rgba(${c.rgb},${r.d.emphasis ? 0.85 : 0.5})`;
            ctx.lineWidth = 1;
            ctx.setLineDash(r.d.dashed ? [5, 4] : []);
            ctx.strokeRect(Math.round(r.x0) + 0.5, Math.round(r.top) + 0.5, Math.max(1, Math.round(r.x1 - r.x0) - 1), Math.max(2, Math.round(r.h)));
            ctx.setLineDash([]);
            continue;
          }
          ctx.strokeStyle = `rgba(${c.rgb},${r.d.emphasis ? 0.95 : 0.6})`;
          ctx.lineWidth = r.d.emphasis ? 1.5 : 1;
          ctx.setLineDash(r.d.dashed ? [6, 4] : []);
          ctx.beginPath();
          ctx.moveTo(r.x0, Math.round(r.y) + 0.5);
          ctx.lineTo(Math.max(r.x0 + 1, r.x1), Math.round(r.y) + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        return;
      }

      ctx.font = '700 10.5px "Inter Variable", Inter, system-ui, sans-serif';
      const labelled = rows.filter((r) => r.d.label && r.d.kind !== 'path');
      const width = new Map(labelled.map((r) => [r.d.id, ctx.measureText(r.d.label).width + 2 * PAD]));
      // Segment labels (BOS / CHOCH / FVG / OB) sit on their segment; level labels at the right edge.
      const inline = labelled.filter((r) => r.d.labelAt === 'segment');
      const edge = labelled.filter((r) => r.d.labelAt !== 'segment');
      const pill = (x: number, top: number, w: number, r: (typeof rows)[number]) => {
        const c = TONE[r.d.tone];
        ctx.fillStyle = 'rgba(10,14,20,0.9)';
        ctx.strokeStyle = `rgba(${c.rgb},${r.d.emphasis ? 0.95 : 0.55})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x + 0.5, top + 0.5, w, LABEL_H, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = c.text;
        ctx.fillText(r.d.label, x + PAD, top + 12.5);
      };
      for (const r of inline) {
        const w = width.get(r.d.id)!;
        const x = Math.max(4, Math.min(mediaSize.width - w - 8, (r.x0 + r.x1) / 2 - w / 2));
        const top = r.d.kind === 'zone' ? r.top + 2 : r.y - LABEL_H - 2;
        if (top < -LABEL_H || top > mediaSize.height) continue;
        pill(x, top, w, r);
      }
      const placed = layoutLabels(edge.map((r) => ({ id: r.d.id, y: r.y, height: LABEL_H, priority: r.d.emphasis ? 0 : 2 })), mediaSize.height);
      for (const p of placed) {
        const r = edge.find((x) => x.d.id === p.id)!;
        const w = width.get(p.id)!;
        pill(mediaSize.width - w - 8, p.top, w, r);
      }
    });
  }
}

class View implements IPrimitivePaneView {
  private readonly r: Renderer;
  constructor(
    src: SmcPrimitive,
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

/** Series primitive for SMC overlays (engine output prepared by smcView — nothing decorative). */
export class SmcPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApiBase<Time> | null = null;
  series: ISeriesApi<SeriesType, Time> | null = null;
  items: SmcDrawable[] = [];
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
  setItems(items: SmcDrawable[]): void {
    this.items = items;
    this.requestUpdate?.();
  }
}
