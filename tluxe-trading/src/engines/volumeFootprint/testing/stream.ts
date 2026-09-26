/**
 * TEST DATA ONLY — deterministic synthetic exchange-trade streams for Volume Footprint tests and the bannered
 * dev harness. Never imported by production code; never shown as market data.
 */
import type { Aggressor, FootprintCapabilities, FootprintMsg, FPTradeMsg } from '../types';

export const FULL_FP_CAPS: FootprintCapabilities = { trades: true, aggressor: 'EXCHANGE', classificationMethod: null, sequenced: true, tradeIds: true, exchangeTimestamps: true };
export const T0_MS = Date.UTC(2026, 0, 6, 14, 0); // Tue 2026-01-06 14:00Z

export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build one trade (TEST DATA). */
export function tr(seq: number, exchTime: number, price: number, size: number, aggressor: Aggressor, o: { contract?: string; latency?: number; id?: string | null; instrumentId?: string } = {}): FPTradeMsg {
  return { type: 'trade', instrumentId: o.instrumentId ?? 'GC', contract: o.contract ?? 'GCZ6', seq, tradeId: o.id === undefined ? `t${seq}` : o.id, exchTime, recvTime: exchTime + (o.latency ?? 20), price, size, aggressor };
}
export const capsMsg = (caps: FootprintCapabilities = FULL_FP_CAPS, recvTime = T0_MS - 1000, instrumentId = 'GC'): FootprintMsg => ({ type: 'caps', instrumentId, recvTime, caps });
export const hb = (exchTime: number, instrumentId = 'GC'): FootprintMsg => ({ type: 'heartbeat', instrumentId, exchTime, recvTime: exchTime + 20 });

/**
 * A realistic-looking session (TEST DATA): mean-reverting walk with directional bursts (imbalances / stacks
 * appear naturally), trades every ~0.5–3 s, heartbeats every 5 s, exchange aggressor side on every trade.
 */
export function generatedStream(o: { minutes: number; seed?: number; start?: number; t0?: number; tick?: number; contract?: string; caps?: FootprintCapabilities; instrumentId?: string }): FootprintMsg[] {
  const r = prng(o.seed ?? 1);
  const tick = o.tick ?? 0.1;
  const id = o.instrumentId ?? 'GC';
  const t0 = o.t0 ?? T0_MS;
  const caps = o.caps ?? FULL_FP_CAPS;
  const out: FootprintMsg[] = [capsMsg(caps, t0 - 1000, id), { type: 'status', instrumentId: id, recvTime: t0 - 900, status: 'LIVE', detail: null }];
  let price = o.start ?? 2400;
  let t = t0;
  let seq = 1;
  let burst = 0;
  let burstDir = 0;
  let nextHb = t0 + 5000;
  const end = t0 + o.minutes * 60_000;
  while (t < end) {
    t += 300 + Math.floor(r() * 2500);
    while (nextHb < t) {
      out.push({ type: 'heartbeat', instrumentId: id, exchTime: nextHb, recvTime: nextHb + 15 });
      nextHb += 5000;
    }
    if (burst <= 0 && r() < 0.02) {
      burst = 8 + Math.floor(r() * 20);
      burstDir = r() < 0.5 ? 1 : -1;
    }
    const drift = burst > 0 ? burstDir : (o.start ?? 2400) > price ? 0.15 : -0.15;
    const move = Math.round((r() - 0.5) * 3 + drift * (burst > 0 ? 1 : 0.3));
    price = Number((price + move * tick).toFixed(2));
    const buyP = burst > 0 ? (burstDir > 0 ? 0.85 : 0.15) : 0.5 + move * 0.1;
    const side: Aggressor = caps.aggressor === 'NONE' ? 'UNKNOWN' : r() < buyP ? 'BUY' : 'SELL';
    const size = 1 + Math.floor(r() ** 3 * 60);
    burst -= 1;
    out.push({ type: 'trade', instrumentId: id, contract: o.contract ?? 'GCZ6', seq, tradeId: `t${seq}`, exchTime: t, recvTime: t + 5 + Math.floor(r() * 30), price, size, aggressor: side });
    seq += 1;
  }
  return out;
}
