import type { Candle } from '../../types/market';
import type { VolumeMode, VolumeSource } from './types';

/*
 * VOLUME SOURCE (one type per profile, never mixed, never synthesized):
 *   EXCHANGE  instrument is an exchange future AND the candles come from a non-MT5 futures feed AND
 *             every bar carries `volume` > 0                     → "COMEX Exchange Volume" (or "<exchange> Exchange Volume")
 *   MT5_REAL  every bar carries MT5 `real_volume` > 0             → "MT5 Real Volume (broker-reported)" — never exchange volume
 *   MT5_TICK  otherwise MT5 `tick_volume` (bars without it are excluded and counted) → "MT5 Tick Volume"
 *   NONE      no usable volume at all                             → "VOLUME DATA UNAVAILABLE"
 */
export interface InstrumentVolumeContext {
  kind: string;
  exchange: string | null;
}

export function chooseVolume(bars: readonly Candle[], ctx: InstrumentVolumeContext): { source: VolumeSource; vol: (c: Candle) => number | null } {
  const pos = (v: number | null | undefined) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const mk = (mode: VolumeMode, label: string, detail: string, vol: (c: Candle) => number | null) => {
    let used = 0;
    for (const b of bars) if (vol(b) !== null) used += 1;
    return { source: { mode, label, detail, usedBars: used, missingBars: bars.length - used }, vol };
  };
  if (!bars.length) return mk('NONE', 'VOLUME DATA UNAVAILABLE', 'No closed candles for this profile.', () => null);
  if (ctx.kind === 'future' && bars.every((b) => b.source !== 'mt5' && pos(b.volume)))
    return mk('EXCHANGE', `${ctx.exchange ?? 'Exchange'} Exchange Volume`, 'Exchange-traded contracts from the futures data provider.', (c) => (pos(c.volume) ? c.volume! : null));
  if (bars.every((b) => pos(b.realVolume)))
    return mk('MT5_REAL', 'MT5 Real Volume (broker-reported)', 'MT5 real_volume as supplied by the broker feed — not COMEX exchange volume.', (c) => (pos(c.realVolume) ? c.realVolume! : null));
  if (bars.some((b) => pos(b.tickVolume)))
    return mk('MT5_TICK', 'MT5 Tick Volume', 'Broker tick count (price changes per bar) — NOT traded or exchange volume.', (c) => (pos(c.tickVolume) ? c.tickVolume! : null));
  return mk('NONE', 'VOLUME DATA UNAVAILABLE', 'The candles carry no tick, real or exchange volume.', () => null);
}
