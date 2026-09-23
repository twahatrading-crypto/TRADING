import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MarketDataService } from '../../services/market/MarketDataService';
import type { InstrumentId } from '../../types/instruments';
import type { Timeframe } from '../../types/market';
import type { ChartController } from './ChartController';

/**
 * Binds one instrument + timeframe candle stream to a ChartController. Changing
 * either tears the chart down, so bars from one instrument can never remain
 * on screen for another. React only learns
 * whether data exists (to toggle the empty state); bar updates bypass React.
 */
export function useChartController(
  market: MarketDataService,
  instrumentId: InstrumentId,
  timeframe: Timeframe,
  priceDecimals: number,
  containerRef: RefObject<HTMLDivElement | null>,
): { barCount: number } {
  const [barCount, setBarCount] = useState(() => market.getCandles(instrumentId, timeframe).length);
  const controllerRef = useRef<ChartController | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loading: Promise<ChartController | null> | null = null;
    setBarCount(market.getCandles(instrumentId, timeframe).length);

    const ensure = () => {
      if (controllerRef.current) return Promise.resolve(controllerRef.current);
      if (!loading) {
        loading = Promise.all([import('lightweight-charts'), import('./ChartController')]).then(([lib, mod]) => {
          if (cancelled || !containerRef.current) return null;
          controllerRef.current = new mod.ChartController(lib, containerRef.current, priceDecimals);
          return controllerRef.current;
        });
      }
      return loading;
    };

    const unsubscribe = market.subscribeCandles(instrumentId, timeframe, (candles, mode) => {
      setBarCount(candles.length);
      if (!candles.length) return;
      void ensure().then((ctl) => {
        if (!ctl) return;
        const last = candles[candles.length - 1]!;
        if (mode === 'upsert' && candles.length > 1) ctl.upsert(last);
        else ctl.setData(candles);
      });
    });

    const existing = market.getCandles(instrumentId, timeframe);
    if (existing.length) void ensure().then((ctl) => ctl?.setData(existing));

    return () => {
      cancelled = true;
      unsubscribe();
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [market, instrumentId, timeframe, priceDecimals, containerRef]);

  return { barCount };
}
