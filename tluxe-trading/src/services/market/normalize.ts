import type { Candle, ConnectionState, MarketState, Quote } from '../../types/market';

const QUOTE_KEYS: (keyof Quote)[] = [
  'last', 'change', 'changePercent', 'bid', 'ask', 'high', 'low', 'volume', 'timestamp', 'spreadPoints',
];

/** Accept only finite numbers; anything else becomes null (unknown). */
export function sanitizeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Merge a partial provider update into a quote. Keys not present are left untouched. */
export function mergeQuote(prev: Quote, update: Partial<Quote>): Quote {
  const next: Quote = { ...prev };
  for (const key of QUOTE_KEYS) {
    if (key in update) next[key] = sanitizeNumber(update[key]);
  }
  return next;
}

export function isValidCandle(c: Candle): boolean {
  const nums = [c.time, c.open, c.high, c.low, c.close];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  return c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.time > 0;
}

/** Drop invalid bars, de-duplicate by time (last wins), sort ascending. */
export function normalizeCandles(input: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of input) {
    if (!isValidCandle(c)) continue;
    const clean: Candle = { ...c, volume: sanitizeNumber(c.volume) };
    if ('tickVolume' in c) clean.tickVolume = sanitizeNumber(c.tickVolume);
    if ('realVolume' in c) clean.realVolume = sanitizeNumber(c.realVolume);
    if ('spread' in c) clean.spread = sanitizeNumber(c.spread);
    byTime.set(c.time, clean);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export type QuoteDisplayMode = 'live' | 'delayed' | 'stale' | 'connecting' | 'unavailable';

export function hasAnyQuoteValue(q: Quote): boolean {
  return q.last !== null || q.bid !== null || q.ask !== null;
}

/**
 * Decide how the quote may be presented. Values are only presented as current
 * when the provider reports LIVE/DELAYED and messages are arriving.
 */
export function getQuoteDisplayMode(state: MarketState, now: number, staleAfterMs: number): QuoteDisplayMode {
  const hasData = hasAnyQuoteValue(state.quote);
  const fresh = state.lastMessageAt !== null && now - state.lastMessageAt <= staleAfterMs;
  if ((state.connection === 'LIVE' || state.connection === 'DELAYED') && hasData) {
    if (!fresh) return 'stale';
    return state.connection === 'LIVE' ? 'live' : 'delayed';
  }
  if (state.connection === 'CONNECTING') return 'connecting';
  return hasData ? 'stale' : 'unavailable';
}

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  LIVE: 'Live',
  DELAYED: 'Delayed',
  CONNECTING: 'Connecting',
  DISCONNECTED: 'Disconnected',
  UNAVAILABLE: 'Data Unavailable',
};
