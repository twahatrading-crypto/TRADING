import type { FeedStatusCode, ProviderInfo } from '../../types/market';
import { FEED_LABEL } from '../../services/mt5/freshness';

/**
 * Provider-aware feed label. The generic status codes (LIVE / STALE / ERROR …) are shared by every provider so
 * the engines' live gating stays identical, but the LABEL always names the real source: Databento COMEX data is
 * never shown as "MT5 · LIVE" and MT5 data is never shown as Databento.
 */
export function feedLabelFor(code: FeedStatusCode, provider: Pick<ProviderInfo, 'id'> | null | undefined): string {
  if (provider?.id === 'databento') {
    if (code === 'LIVE') return 'DATABENTO · LIVE';
    if (code === 'STALE') return 'DATABENTO · STALE';
    if (code === 'INSUFFICIENT_HISTORY') return 'DATABENTO · INSUFFICIENT HISTORY';
    return 'DATABENTO · DATA UNAVAILABLE';
  }
  return FEED_LABEL[code];
}
