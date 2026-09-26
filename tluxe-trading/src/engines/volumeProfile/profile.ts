import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import { VP_TF_SECONDS, type VPSettings } from './config';
import { accumulate, rowSize, rowsOf, valueArea } from './histogram';
import { detectNodes, strengthLabel } from './nodes';
import type { ProfileKind, VolumeNode, VolumeProfile } from './types';
import { chooseVolume, type InstrumentVolumeContext } from './volume';

export interface BuildArgs {
  instrumentId: InstrumentId;
  kind: ProfileKind;
  label: string;
  id: string;
  resolution: Timeframe;
  /** Closed bars of the resolution timeframe, ascending. */
  bars: readonly Candle[];
  from: number;
  to: number;
  /** Knowledge time (s): only bars that CLOSED by K are used. */
  K: number;
  bp: number;
  tick: number;
  ctx: InstrumentVolumeContext;
  settings: VPSettings;
  /** Open time of the first loaded bar of this timeframe (history truncation → partial). */
  datasetStart: number | null;
}

const r10 = (x: number) => Number(x.toFixed(10));

/** Build one profile from the closed bars in [from, min(to, K)). Pure: same inputs → same profile. */
export function buildProfile(a: BuildArgs): VolumeProfile {
  const tf = VP_TF_SECONDS[a.resolution];
  const end = Math.min(a.to, a.K);
  const bars = a.bars.filter((b) => b.time >= a.from && b.time + tf <= end);
  const { source, vol } = chooseVolume(bars, a.ctx);
  const complete = a.K >= a.to;
  const lastBarClose = bars.length ? bars[bars.length - 1]!.time + tf : null;
  const base: VolumeProfile = {
    id: a.id,
    kind: a.kind,
    label: a.label,
    instrumentId: a.instrumentId,
    resolution: a.resolution,
    from: a.from,
    to: a.to,
    complete,
    bars: bars.length,
    firstBar: bars[0]?.time ?? null,
    lastBarClose,
    binSize: 0,
    rows: [],
    total: 0,
    poc: null,
    pocVolume: 0,
    vah: null,
    val: null,
    vaVolume: 0,
    vaShare: 0,
    valueAreaTarget: a.settings.valueAreaPct,
    high: bars.length ? Math.max(...bars.map((b) => b.high)) : null,
    low: bars.length ? Math.min(...bars.map((b) => b.low)) : null,
    source,
    hvn: [],
    lvn: [],
    partial: a.datasetStart !== null && a.datasetStart > a.from,
  };
  if (source.mode === 'NONE' || !bars.length) return base;
  const size = rowSize(bars[0]!.open, a.bp, a.tick);
  const hist = new Map<number, number>();
  for (const b of bars) {
    const v = vol(b);
    if (v !== null) accumulate(hist, b, v, size);
  }
  const rows = rowsOf(hist, size);
  const va = valueArea(rows, size, a.settings.valueAreaPct);
  if (!va) return { ...base, binSize: size, rows };
  const nodes: VolumeNode[] = detectNodes(rows, a.settings).map((n) => {
    const low = rows[n.lowIndex]!.price;
    const high = r10(rows[n.highIndex]!.price + size);
    const node: VolumeNode = {
      id: `${a.id}:${n.type}:${rows[n.index]!.price}`,
      type: n.type,
      low,
      high,
      price: r10(rows[n.index]!.price + size / 2),
      relVolume: n.rel,
      volume: n.volume,
      strength: n.strength,
      strengthLabel: 'Weak',
      profileId: a.id,
      profileKind: a.kind,
      createdAt: a.from,
      confirmedAt: complete ? lastBarClose : null,
      validFrom: complete ? Math.max(a.to, lastBarClose ?? a.to) : null,
      developing: !complete,
      state: 'ACTIVE',
      testedAt: null,
      brokenAt: null,
      evidence: n.type === 'HVN' ? `local volume peak, ${(n.rel * 100).toFixed(0)}% of the profile's smoothed maximum` : `volume valley at ${(n.rel * 100).toFixed(0)}% of the maximum, ≤ ${(a.settings.lvnFlankRatio * 100).toFixed(0)}% of both flanking peaks`,
    };
    node.strengthLabel = strengthLabel(node);
    return node;
  });
  return {
    ...base,
    binSize: size,
    rows,
    total: va.total,
    poc: va.poc,
    pocVolume: va.pocVolume,
    vah: va.vah,
    val: va.val,
    vaVolume: va.vaVolume,
    vaShare: va.vaVolume / va.total,
    hvn: nodes.filter((n) => n.type === 'HVN'),
    lvn: nodes.filter((n) => n.type === 'LVN'),
  };
}
