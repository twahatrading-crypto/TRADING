import { useEffect, useRef } from 'react';
import { fromTick, toTick } from '../../engines/orderFlowPro/classify';
import type { DepthRecorder } from '../../engines/orderFlowPro/depthRecorder';
import type { SeriesPoint } from '../../engines/orderFlowPro/metrics';
import type { VolumeProfileResult } from '../../engines/orderFlowPro/profile';
import { fmtNum } from './ofpFormat';

/** Draw into a DPR-scaled canvas sized to its parent; re-runs when `deps` change. */
function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext?.('2d');
    if (!c || !ctx) return;
    const paint = () => {
      const r = c.parentElement!.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const w = Math.max(10, Math.floor(r.width));
      const h = Math.max(10, Math.floor(r.height));
      c.width = w * dpr;
      c.height = h * dpr;
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      draw(ctx, w, h);
    };
    paint();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(paint);
    ro.observe(c.parentElement!);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the data the drawing depends on
  }, deps);
  return ref;
}

const AXIS = 44;

/** Mini series: 'area' (CVD) or 'bars' (volume / delta / OFI) with a right-hand scale. */
export function MiniSeries({ points, mode, label }: { points: readonly SeriesPoint[]; mode: 'area' | 'bars'; label: string }) {
  const ref = useCanvas(
    (ctx, w, h) => {
      const pw = w - AXIS;
      ctx.font = '500 10px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#6d7686';
      if (!points.length) {
        ctx.fillText('No data', 6, h / 2);
        return;
      }
      const vals = points.map((p) => p.v);
      let lo = Math.min(0, ...vals);
      let hi = Math.max(0, ...vals);
      if (hi === lo) hi = lo + 1;
      const m = Math.max(Math.abs(lo), Math.abs(hi));
      if (mode === 'area' || lo < 0) {
        lo = -m;
        hi = m;
      }
      const y = (v: number) => h - 4 - ((v - lo) / (hi - lo)) * (h - 8);
      const n = points.length;
      const step = pw / Math.max(n, 1);
      ctx.strokeStyle = 'rgba(120,140,180,0.15)';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y(0)) + 0.5);
      ctx.lineTo(pw, Math.round(y(0)) + 0.5);
      ctx.stroke();
      if (mode === 'bars') {
        const bw = Math.max(1, step * 0.7);
        points.forEach((p, i) => {
          const x = i * step + (step - bw) / 2;
          ctx.fillStyle = label === 'Volume' ? (p.partial ? 'rgba(160,168,184,0.7)' : 'rgba(38,208,124,0.8)') : p.v >= 0 ? 'rgba(38,208,124,0.85)' : 'rgba(239,75,95,0.85)';
          if (label === 'Volume' && i > 0 && p.v < points[i - 1]!.v && !p.partial) ctx.fillStyle = 'rgba(239,75,95,0.8)';
          const y0 = y(Math.max(0, p.v));
          const y1 = y(Math.min(0, p.v));
          ctx.fillRect(x, y0, bw, Math.max(1, y1 - y0));
        });
      } else {
        ctx.beginPath();
        points.forEach((p, i) => {
          const x = i * step + step / 2;
          if (i === 0) ctx.moveTo(x, y(p.v));
          else ctx.lineTo(x, y(p.v));
        });
        const last = points[n - 1]!;
        ctx.strokeStyle = last.v >= 0 ? '#26d07c' : '#ef4b5f';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineTo((n - 1) * step + step / 2, y(0));
        ctx.lineTo(step / 2, y(0));
        ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, 'rgba(38,208,124,0.25)');
        g.addColorStop(0.5, 'rgba(38,208,124,0.02)');
        g.addColorStop(1, 'rgba(239,75,95,0.25)');
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.fillStyle = '#8b93a3';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtNum(hi), pw + 6, 8);
      if (lo < 0) ctx.fillText('0', pw + 6, y(0));
      ctx.fillText(fmtNum(lo), pw + 6, h - 8);
    },
    [points, mode, label],
  );
  return (
    <div className="ofp-mini__body">
      <canvas ref={ref} className="ofp-mini__canvas" aria-label={`${label} chart`} />
    </div>
  );
}

const heatRgb = (v: number, side: 'BID' | 'ASK') => {
  const a = 0.15 + 0.85 * v;
  return side === 'BID' ? `rgba(${Math.round(20 + 30 * v)},${Math.round(120 + 110 * v)},${Math.round(70 + 40 * v)},${a})` : `rgba(${Math.round(150 + 105 * v)},${Math.round(30 + 40 * v)},${Math.round(50 + 30 * v)},${a})`;
};

/** Recorded bid / ask resting size over the last `spanMs`, side by side, around the current price. */
export function DepthHeatmap({ recorder, center, now, spanMs, rows, precision, version }: { recorder: DepthRecorder; center: number | null; now: number; spanMs: number; rows: number; precision: number; version: number }) {
  const ref = useCanvas(
    (ctx, w, h) => {
      const pw = w - 52;
      ctx.font = '500 10px Inter, system-ui, sans-serif';
      if (center === null || !recorder.columnCount) {
        ctx.fillStyle = '#6d7686';
        ctx.fillText('No recorded depth', 8, h / 2);
        return;
      }
      const tick = recorder.tick;
      const ck = toTick(center, tick);
      const k0 = ck - rows;
      const k1 = ck + rows;
      const cols = recorder.columnsIn(now - spanMs, now);
      let max = 0;
      for (const c of cols) if (c.validMs > 0) for (const cell of c.cells.values()) max = Math.max(max, cell.sizeMs / c.validMs);
      const half = pw / 2 - 3;
      const rowH = h / (k1 - k0 + 1);
      const colW = half / Math.max(1, Math.round(spanMs / recorder.bucketMs));
      for (const c of cols) {
        if (c.validMs <= 0) continue;
        const xi = (c.t - (now - spanMs)) / recorder.bucketMs;
        for (const cell of c.cells.values()) {
          if (cell.tick < k0 || cell.tick > k1) continue;
          const v = max ? Math.sqrt(cell.sizeMs / c.validMs / max) : 0;
          if (v < 0.05) continue;
          ctx.fillStyle = heatRgb(v, cell.side);
          const x = (cell.side === 'BID' ? 0 : half + 6) + xi * colW;
          ctx.fillRect(x, (k1 - cell.tick) * rowH, Math.max(1, colW), Math.max(1, rowH - 1));
        }
      }
      ctx.fillStyle = '#8b93a3';
      ctx.textBaseline = 'middle';
      const every = Math.max(1, Math.round((k1 - k0) / 6));
      for (let k = k1; k >= k0; k -= every) ctx.fillText(fromTick(k, tick).toFixed(precision), pw + 6, (k1 - k + 0.5) * rowH);
    },
    [recorder, center, now, spanMs, rows, precision, version],
  );
  return <canvas ref={ref} className="ofp-depth__canvas" aria-label="Depth heatmap (recorded resting size)" />;
}

/** Horizontal session volume profile with POC / value area highlighted. */
export function ProfileMini({ profile, version }: { profile: VolumeProfileResult; version: number }) {
  const ref = useCanvas(
    (ctx, w, h) => {
      if (!profile.rows.length || profile.low === null || profile.high === null) {
        ctx.fillStyle = '#6d7686';
        ctx.font = '500 10px Inter, system-ui, sans-serif';
        ctx.fillText('No executed volume', 6, h / 2);
        return;
      }
      const span = profile.high - profile.low + 1;
      const rowH = h / span;
      const max = Math.max(...profile.rows.map((r) => r.volume));
      ctx.strokeStyle = 'rgba(91,140,255,0.6)';
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      ctx.setLineDash([]);
      for (const r of profile.rows) {
        const inVa = profile.val !== null && profile.vah !== null && r.tick >= profile.val && r.tick <= profile.vah;
        ctx.fillStyle = r.tick === profile.poc ? '#f5a524' : inVa ? 'rgba(140,124,255,0.85)' : 'rgba(123,108,255,0.4)';
        const bw = (r.volume / max) * (w - 4);
        ctx.fillRect(w - 2 - bw, (profile.high - r.tick) * rowH, bw, Math.max(1, rowH - (rowH > 3 ? 1 : 0)));
      }
    },
    [profile, version],
  );
  return <canvas ref={ref} className="ofp-vpmini__canvas" aria-label="Session volume profile" />;
}

