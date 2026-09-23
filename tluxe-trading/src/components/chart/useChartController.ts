import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MarketDataService } from '../../services/market/MarketDataService';
import type { InstrumentId } from '../../types/instruments';
import type { Candle, Timeframe } from '../../types/market';
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
  /**
   * Replay: when non-null the chart shows ONLY these bars and ignores the live
   * stream (live chart advancement is frozen for the replay session).
   */
  override: readonly Candle[] | null = null,
): { barCount: number; controller: ChartController | null; lastBar: Candle | null } {
  const [barCount, setBarCount] = useState(() => market.getCandles(instrumentId, timeframe).length);
  const [lastBar, setLastBar] = useState<Candle | null>(() => market.getCandles(instrumentId, timeframe).at(-1) ?? null);
  const controllerRef = useRef<ChartController | null>(null);
  const [controller, setController] = useState<ChartController | null>(null);

  const replay = override !== null;
  const overrideRef = useRef(override);
  const shownRef = useRef<readonly Candle[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loading: Promise<ChartController | null> | null = null;
    if (replay) {
      // Replay mode: no live subscription at all.
      void (async () => {
        const [lib, mod] = await Promise.all([import('lightweight-charts'), import('./ChartController')]);
        if (cancelled || !containerRef.current) return;
        controllerRef.current = new mod.ChartController(lib, containerRef.current, priceDecimals);
        const bars = overrideRef.current ?? [];
        controllerRef.current.setData(bars);
        shownRef.current = bars;
        setController(controllerRef.current);
      })();
      return () => {
        cancelled = true;
        controllerRef.current?.destroy();
        controllerRef.current = null;
        shownRef.current = null;
        setController(null);
      };
    }
    setBarCount(market.getCandles(instrumentId, timeframe).length);
    setLastBar(market.getCandles(instrumentId, timeframe).at(-1) ?? null);

    const ensure = () => {
      if (controllerRef.current) return Promise.resolve(controllerRef.current);
      if (!loading) {
        loading = Promise.all([import('lightweight-charts'), import('./ChartController')]).then(([lib, mod]) => {
          if (cancelled || !containerRef.current) return null;
          controllerRef.current = new mod.ChartController(lib, containerRef.current, priceDecimals);
          setController(controllerRef.current);
          return controllerRef.current;
        });
      }
      return loading;
    };

    const unsubscribe = market.subscribeCandles(instrumentId, timeframe, (candles, mode) => {
      setBarCount(candles.length);
      setLastBar(candles.at(-1) ?? null);
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
      setController(null);
    };
  }, [market, instrumentId, timeframe, priceDecimals, containerRef, replay]);

  // Replay bars → chart. One revealed bar = one upsert; anything else (step back, seek, TF switch) = full redraw.
  useEffect(() => {
    overrideRef.current = override;
    const ctl = controllerRef.current;
    if (!override || !ctl) return;
    const prev = shownRef.current;
    const appendedOne = prev && override.length === prev.length + 1 && (prev.length === 0 || override[prev.length - 1] === prev[prev.length - 1]);
    if (appendedOne && override.length) ctl.upsert(override[override.length - 1]!);
    else ctl.setData(override);
    shownRef.current = override;
  }, [override, controller]);

  if (override) return { barCount: override.length, controller, lastBar: override.at(-1) ?? null };
  return { barCount, controller, lastBar };
}
