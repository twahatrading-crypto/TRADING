import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
import type { BridgeBar } from './protocol';

/**
 * Bridge bar → canonical candle. `time` is the bridge's UTC open time; the raw
 * MT5 server-time is kept in `sourceTime`. Missing real volume stays null;
 * tick volume is never presented as real volume.
 */
export function barToCandle(b: BridgeBar, ctx: { instrumentId: InstrumentId; providerSymbol: string; timeframe: Timeframe }): Candle {
  return {
    time: b.t,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.rv ?? null,
    tickVolume: b.tv,
    realVolume: b.rv ?? null,
    spread: b.sp,
    instrumentId: ctx.instrumentId,
    providerSymbol: ctx.providerSymbol,
    timeframe: ctx.timeframe,
    source: 'mt5',
    isClosed: b.closed,
    sourceTime: b.st,
  };
}

/** Reciprocal pair (e.g. CADUSD) → canonical orientation (USDCAD). Spread in points is not transferable → null. */
export function invertCandle(c: Candle): Candle {
  return { ...c, open: 1 / c.open, high: 1 / c.low, low: 1 / c.high, close: 1 / c.close, spread: null };
}
