import { useEffect, useMemo, useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { TIMEFRAMES } from '../../config/instrument';
import { assessQuality } from '../../engines/srPro/dataQuality';
import { feedStatus } from '../../engines/srPro/feedState';
import { computeKeyLevels, TF_SECONDS, type AsiaSessionId, type BarsByTf } from '../../engines/srPro/keyLevels';
import type { AnalysisInput } from '../../engines/srPro/analysis';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { usePersistentState } from '../../hooks/usePersistentState';
import { useIbkrDepthState } from '../../providers/ibkr/ibkrView';
import { useStore } from '../../store/createStore';
import type { Timeframe } from '../../types/market';
import { useSRSettings, useSRState } from '../sr/useSR';

const isAsia = (v: unknown): v is AsiaSessionId => v === 'cme-asia' || v === 'tokyo';

/** Wall clock that re-renders every `ms` (feed freshness is judged against it). */
function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Everything the S&R Pro page shows, assembled from the EXISTING engine services and the
 * real candles in MarketDataService. Nothing here computes a zone, a structure break or a
 * liquidity pool; it only reads snapshots (and checks they belong to the active instrument).
 */
export function useSRPro() {
  const def = useActiveInstrument();
  const services = useServices();
  const { market, smc, liquidity, orderBlocks, volumeProfile } = services;
  const decimals = useMarket((s) => s.instrument.priceDecimals);
  const connection = useMarket((s) => s.connection);
  const providerSymbol = useMarket((s) => s.feed?.providerSymbol ?? null);
  const providerName = useMarket((s) => s.provider?.name ?? null);
  const multi = useSRState((s) => s.multi);
  const byTf = useSRState((s) => s.byTimeframe);
  const computedAt = useSRState((s) => s.computedAt);
  const [settings] = useSRSettings();
  const smcState = useStore(smc.store, (s) => s);
  const liq = useStore(liquidity.store(def.id), (s) => s.multi);
  const ob = useStore(orderBlocks.store(def.id), (s) => s.multi);
  const vpState = useStore(volumeProfile.store, (s) => s);
  const ibkr = useIbkrDepthState(def.id);
  const [asia, setAsia] = usePersistentState<AsiaSessionId>('tluxe.srpro.asia', 'cme-asia', isAsia);
  const now = useNow();

  // Candles are read when the S&R service recomputed (it does so on every candle update).
  const candles = useMemo<BarsByTf>(() => {
    const out: BarsByTf = {};
    for (const tf of TIMEFRAMES) out[tf] = market.getCandles(def.id, tf);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, def.id, computedAt]);

  const quality = useMemo(() => assessQuality(candles.D1, candles.H1), [candles]);
  const keyLevels = useMemo(() => computeKeyLevels(candles, asia), [candles, asia]);
  const finest = (TIMEFRAMES as Timeframe[]).find((tf) => (candles[tf]?.length ?? 0) > 0) ?? null;
  const newest = finest ? candles[finest]![candles[finest]!.length - 1]! : null;
  const feed = feedStatus({ now, newestBarTime: newest?.time ?? null, newestBarSeconds: finest ? TF_SECONDS[finest] : 60, connected: connection === 'LIVE' || connection === 'DELAYED' });

  const smcSnap = smcState.instrumentId === def.id ? smcState.snapshot : null;
  const vp = vpState.snapshot && vpState.snapshot.instrumentId === def.id ? vpState.snapshot : null;
  const price = newest?.close ?? null;
  const candleSource = [providerName ?? 'Provider', providerSymbol].filter(Boolean).join(' · ');

  const input: AnalysisInput = useMemo(
    () => ({
      zones: multi?.zones ?? [],
      confluences: multi?.confluences ?? [],
      byTf,
      candles,
      settings,
      quality,
      levels: keyLevels.levels,
      smc: smcSnap,
      pools: liq?.pools ?? [],
      blocks: ob?.blocks ?? [],
      vp,
      feed,
      price,
      sources: { feedLabel: feed.label, candleSource, decimals },
    }),
    // feed changes identity every tick; its state/label are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [multi, byTf, candles, settings, quality, keyLevels, smcSnap, liq, ob, vp, feed.state, feed.label, price, candleSource, decimals],
  );

  return { def, decimals, input, feed, quality, keyLevels, asia, setAsia, ibkr, smcSnap, candles, providerSymbol };
}
