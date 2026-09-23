/**
 * MT5 bridge connection settings. Stored in THIS browser only (localStorage) —
 * never compiled into the app bundle and never sent anywhere except the bridge.
 */
export interface Mt5Config {
  enabled: boolean;
  /** Bridge base URL, private by default (the bridge binds to 127.0.0.1). */
  bridgeUrl: string;
  token: string;
  /** History bars requested per timeframe on first load. */
  historyBars: number;
  /** Bars requested per timeframe when resyncing after a reconnect. */
  resyncBars: number;
  healthMs: number;
  quoteMs: number;
  candleMs: number;
  requestTimeoutMs: number;
  /** No bridge heartbeat for this long → MT5 BRIDGE OFFLINE. */
  heartbeatStaleMs: number;
  /** No new tick for this long while the market is open → STALE. */
  quoteStaleMs: number;
  /** Forming bar older than this many bar lengths while open → STALE. */
  candleStaleBars: number;
  /** Closed bars below this on every loaded timeframe → INSUFFICIENT HISTORY. */
  minHistoryBars: number;
  /** Explicit canonical → broker symbol overrides (highest priority). */
  overrides: Record<string, { symbol: string; inverted?: boolean }>;
}

export const MT5_CONFIG_KEY = 'tluxe.mt5.config.v1';

export const DEFAULT_MT5_CONFIG: Readonly<Mt5Config> = Object.freeze({
  enabled: false,
  bridgeUrl: 'http://127.0.0.1:8765',
  token: '',
  historyBars: 5000,
  resyncBars: 500,
  healthMs: 5000,
  quoteMs: 1000,
  candleMs: 2000,
  requestTimeoutMs: 15000,
  heartbeatStaleMs: 15000,
  quoteStaleMs: 60000,
  candleStaleBars: 2,
  minHistoryBars: 50,
  overrides: {},
});

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

export function sanitizeMt5Config(input: unknown): Mt5Config {
  const d = DEFAULT_MT5_CONFIG;
  const o = (input && typeof input === 'object' ? input : {}) as Partial<Mt5Config>;
  const url = typeof o.bridgeUrl === 'string' && /^https?:\/\/[^\s]+$/.test(o.bridgeUrl.trim()) ? o.bridgeUrl.trim().replace(/\/+$/, '') : d.bridgeUrl;
  const overrides: Mt5Config['overrides'] = {};
  if (o.overrides && typeof o.overrides === 'object') {
    for (const [k, v] of Object.entries(o.overrides)) {
      if (v && typeof v === 'object' && typeof v.symbol === 'string' && v.symbol.trim()) overrides[k] = { symbol: v.symbol.trim(), inverted: !!v.inverted };
    }
  }
  return {
    enabled: o.enabled === true,
    bridgeUrl: url,
    token: typeof o.token === 'string' ? o.token.trim() : '',
    historyBars: num(o.historyBars, 100, 50000, d.historyBars),
    resyncBars: num(o.resyncBars, 10, 5000, d.resyncBars),
    healthMs: num(o.healthMs, 1000, 60000, d.healthMs),
    quoteMs: num(o.quoteMs, 250, 60000, d.quoteMs),
    candleMs: num(o.candleMs, 500, 60000, d.candleMs),
    requestTimeoutMs: num(o.requestTimeoutMs, 1000, 120000, d.requestTimeoutMs),
    heartbeatStaleMs: num(o.heartbeatStaleMs, 3000, 300000, d.heartbeatStaleMs),
    quoteStaleMs: num(o.quoteStaleMs, 5000, 3600000, d.quoteStaleMs),
    candleStaleBars: num(o.candleStaleBars, 1, 20, d.candleStaleBars),
    minHistoryBars: num(o.minHistoryBars, 1, 5000, d.minHistoryBars),
    overrides,
  };
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

export function loadMt5Config(storage: KV | null): Mt5Config {
  try {
    const raw = storage?.getItem(MT5_CONFIG_KEY);
    return sanitizeMt5Config(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeMt5Config(null);
  }
}

export function saveMt5Config(storage: KV | null, cfg: Mt5Config): void {
  try {
    storage?.setItem(MT5_CONFIG_KEY, JSON.stringify(sanitizeMt5Config(cfg)));
  } catch {
    /* storage blocked */
  }
}
