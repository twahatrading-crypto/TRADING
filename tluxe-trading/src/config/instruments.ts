import type {
  AssetClass,
  DataCapability,
  InstrumentDefinition,
  InstrumentId,
  ProviderMapping,
} from '../types/instruments';
import { ASSET_CLASS_ORDER } from '../types/instruments';
import type { SessionDefinition } from '../utils/sessions';
import { SESSIONS } from './sessions';

/*
 * Canonical instrument registry.
 *
 * Internal ids are ours. Provider symbols are NOT assumed: mappings carry
 * `symbol: null` + discovery hints, and each adapter must discover/validate
 * the real symbol (see services/market/symbolMapping.ts).
 */

const FUTURES_PRICE: DataCapability[] = ['quote', 'ohlcv', 'trades', 'level1', 'historicalCandles'];
const DEPTH: DataCapability[] = ['level2', 'marketDepth', 'mbo', 'mbp'];
const MT5_PRICE: DataCapability[] = ['quote', 'ohlcv', 'level1', 'historicalCandles'];
const CRYPTO_PRICE: DataCapability[] = ['quote', 'ohlcv', 'trades', 'level1', 'historicalCandles'];
/** Crypto venues publish order books, but as a separate depth source (never implied by price). */
const CRYPTO_DEPTH: DataCapability[] = ['level2', 'marketDepth', 'mbp'];
const INDEX_PRICE: DataCapability[] = ['quote', 'ohlcv', 'historicalCandles'];

const GLOBEX = SESSIONS.find((s) => s.id === 'globex')!;

/** Typical OTC FX/metals week: Sun 17:00 → Fri 17:00 New York. Broker hours can differ. */
const OTC_WEEK: SessionDefinition = {
  id: 'otc-week',
  name: 'OTC (broker)',
  timeZone: 'America/New_York',
  open: { hour: 17, minute: 0 },
  close: { hour: 17, minute: 0 },
  openDays: [0, 1, 2, 3, 4],
  rule: 'Sun–Fri 17:00 New York (typical; broker-specific)',
};

const map = (m: Omit<ProviderMapping, 'symbol' | 'discoveryHints'> & Partial<ProviderMapping>): ProviderMapping => ({
  symbol: null,
  discoveryHints: [],
  ...m,
});

type Def = Omit<InstrumentDefinition, 'capabilities'>;

function define(d: Def): InstrumentDefinition {
  const caps = new Set<DataCapability>();
  d.providerMappings.forEach((m) => m.capabilities.forEach((c) => caps.add(c)));
  return { ...d, capabilities: [...caps] };
}

const fxPair = (base: string, quote: string, name: string): InstrumentDefinition =>
  define({
    id: `${base}${quote}`,
    displayName: `${base}${quote} — ${name}`,
    shortName: `${base}${quote}`,
    name,
    assetClass: 'forex',
    kind: 'fx-pair',
    exchange: null,
    venue: 'MT5 broker feed',
    currency: quote,
    pricePrecision: quote === 'JPY' ? 3 : 5,
    tradable: true,
    aliases: [`${base}/${quote}`],
    providerMappings: [
      map({
        family: 'mt5',
        role: 'price',
        discoveryHints: [`${base}${quote}`],
        capabilities: MT5_PRICE,
        note: `If a provider only lists ${quote}${base}, it is mapped as an inverted quote; the canonical pair stays ${base}${quote}.`,
      }),
    ],
    tradingHours: OTC_WEEK,
    newsTopics: ['FX', 'USD', 'FED', 'RATES', 'INFLATION'],
    calendarCurrencies: [base, quote],
    fx: { base, quote },
  });

const cryptoPair = (base: string, name: string, precision: number): InstrumentDefinition =>
  define({
    id: `${base}USD`,
    displayName: `${base}USD — ${name}`,
    shortName: `${base}USD`,
    name,
    assetClass: 'crypto',
    kind: 'crypto-pair',
    exchange: null,
    venue: 'Provider-dependent (exchange or broker)',
    currency: 'USD',
    pricePrecision: precision,
    tradable: true,
    aliases: [name, `${base}/USD`, base],
    providerMappings: [
      map({ family: 'crypto-feed', role: 'price', discoveryHints: [`${base}USD`, `${base}USDT`, `${base}-USD`], capabilities: CRYPTO_PRICE }),
      map({ family: 'depth-feed', role: 'depth', discoveryHints: [`${base}USD`, `${base}USDT`, `${base}-USD`], capabilities: CRYPTO_DEPTH, note: 'Venue order book — provider-dependent' }),
      map({ family: 'mt5', role: 'price', discoveryHints: [`${base}USD`], capabilities: MT5_PRICE, note: 'Only if the broker offers it.' }),
    ],
    tradingHours: '24/7',
    newsTopics: ['CRYPTO', 'USD', 'FED', 'RATES'],
    calendarCurrencies: ['USD'],
  });

export const INSTRUMENTS: readonly InstrumentDefinition[] = [
  // ---------------- Futures (COMEX, exchange-traded) ----------------
  define({
    id: 'GC',
    displayName: 'GC — COMEX Gold Futures',
    shortName: 'GC',
    name: 'COMEX Gold Futures',
    assetClass: 'futures',
    kind: 'future',
    exchange: 'COMEX',
    venue: 'CME Globex (COMEX)',
    currency: 'USD',
    pricePrecision: 1,
    tradable: true,
    aliases: ['gold', 'gold futures'],
    providerMappings: [
      map({ family: 'futures-feed', role: 'price', discoveryHints: ['GC'], capabilities: FUTURES_PRICE }),
      map({ family: 'depth-feed', role: 'depth', discoveryHints: ['GC'], capabilities: DEPTH, note: 'e.g. Bookmap — COMEX order book' }),
    ],
    tradingHours: GLOBEX,
    newsTopics: ['GOLD', 'USD', 'FED', 'RATES', 'INFLATION', 'GEOPOLITICS', 'COMEX'],
    calendarCurrencies: ['USD'],
  }),
  define({
    id: 'SI',
    displayName: 'SI — COMEX Silver Futures',
    shortName: 'SI',
    name: 'COMEX Silver Futures',
    assetClass: 'futures',
    kind: 'future',
    exchange: 'COMEX',
    venue: 'CME Globex (COMEX)',
    currency: 'USD',
    pricePrecision: 3,
    tradable: true,
    aliases: ['silver', 'silver futures'],
    providerMappings: [
      map({ family: 'futures-feed', role: 'price', discoveryHints: ['SI'], capabilities: FUTURES_PRICE }),
      map({ family: 'depth-feed', role: 'depth', discoveryHints: ['SI'], capabilities: DEPTH, note: 'e.g. Bookmap — COMEX order book' }),
    ],
    tradingHours: GLOBEX,
    newsTopics: ['SILVER', 'GOLD', 'USD', 'FED', 'RATES', 'INFLATION', 'COMEX'],
    calendarCurrencies: ['USD'],
  }),

  // ---------------- Metals (spot/CFD via MT5 broker — NOT COMEX) ----------------
  define({
    id: 'XAUUSD',
    displayName: 'XAUUSD — Gold / US Dollar',
    shortName: 'XAUUSD',
    name: 'Gold / US Dollar',
    assetClass: 'metals',
    kind: 'spot-otc',
    exchange: null,
    venue: 'MT5 broker feed (spot/CFD)',
    currency: 'USD',
    pricePrecision: 2,
    tradable: true,
    aliases: ['gold', 'gold spot', 'XAU/USD'],
    providerMappings: [
      map({ family: 'mt5', role: 'price', discoveryHints: ['XAUUSD', 'GOLD'], capabilities: MT5_PRICE }),
    ],
    tradingHours: OTC_WEEK,
    newsTopics: ['GOLD', 'USD', 'FED', 'RATES', 'INFLATION', 'GEOPOLITICS'],
    calendarCurrencies: ['USD'],
  }),
  define({
    id: 'XAGUSD',
    displayName: 'XAGUSD — Silver / US Dollar',
    shortName: 'XAGUSD',
    name: 'Silver / US Dollar',
    assetClass: 'metals',
    kind: 'spot-otc',
    exchange: null,
    venue: 'MT5 broker feed (spot/CFD)',
    currency: 'USD',
    pricePrecision: 3,
    tradable: true,
    aliases: ['silver', 'silver spot', 'XAG/USD'],
    providerMappings: [
      map({ family: 'mt5', role: 'price', discoveryHints: ['XAGUSD', 'SILVER'], capabilities: MT5_PRICE }),
    ],
    tradingHours: OTC_WEEK,
    newsTopics: ['SILVER', 'GOLD', 'USD', 'FED', 'RATES', 'INFLATION'],
    calendarCurrencies: ['USD'],
  }),

  // ---------------- Forex (MT5 broker) ----------------
  fxPair('EUR', 'USD', 'Euro / US Dollar'),
  fxPair('GBP', 'USD', 'British Pound / US Dollar'),
  fxPair('AUD', 'USD', 'Australian Dollar / US Dollar'),
  fxPair('USD', 'CAD', 'US Dollar / Canadian Dollar'),

  // ---------------- Crypto (provider-dependent) ----------------
  cryptoPair('BTC', 'Bitcoin', 2),
  cryptoPair('ETH', 'Ethereum', 2),
  cryptoPair('SOL', 'Solana', 3),

  // ---------------- Indices ----------------
  define({
    id: 'DXY',
    displayName: 'DXY — U.S. Dollar Index',
    shortName: 'DXY',
    name: 'U.S. Dollar Index',
    assetClass: 'indices',
    kind: 'index',
    exchange: null,
    venue: 'Provider-dependent (index, futures or CFD)',
    currency: 'USD',
    pricePrecision: 3,
    tradable: true,
    aliases: ['dollar index', 'usdx', 'dollar'],
    providerMappings: [
      map({ family: 'index-feed', role: 'price', discoveryHints: ['DXY', 'USDX'], capabilities: INDEX_PRICE }),
      map({ family: 'mt5', role: 'price', discoveryHints: ['DXY', 'USDX', 'USDIDX'], capabilities: MT5_PRICE, note: 'Only if the broker offers it.' }),
    ],
    tradingHours: null,
    newsTopics: ['USD', 'FED', 'RATES', 'INFLATION', 'FX'],
    calendarCurrencies: ['USD'],
  }),
  define({
    id: 'NASDAQ',
    displayName: 'NASDAQ — Nasdaq market / index category',
    shortName: 'NASDAQ',
    name: 'Nasdaq market / index category',
    assetClass: 'indices',
    kind: 'category',
    exchange: null,
    venue: 'Resolves to a specific instrument per provider',
    currency: 'USD',
    pricePrecision: 2,
    tradable: false,
    aliases: ['nasdaq', 'nasdaq 100', 'ndx', 'nq', 'us100', 'tech'],
    // Deliberately no mappings: a concrete variant must be chosen per provider later.
    providerMappings: [],
    variants: [
      { label: 'Nasdaq-100 Index (NDX)', kind: 'index', family: 'index-feed' },
      { label: 'Nasdaq-100 E-mini futures (NQ)', kind: 'future', family: 'futures-feed' },
      { label: 'Nasdaq-100 CFD (broker)', kind: 'spot-otc', family: 'mt5' },
    ],
    tradingHours: null,
    newsTopics: ['EQUITIES', 'USD', 'FED', 'RATES', 'INFLATION'],
    calendarCurrencies: ['USD'],
  }),
];

export const DEFAULT_INSTRUMENT_ID: InstrumentId = 'GC';

const BY_ID = new Map(INSTRUMENTS.map((i) => [i.id, i]));

export function getInstrument(id: InstrumentId): InstrumentDefinition | undefined {
  return BY_ID.get(id);
}

export function isInstrumentId(v: unknown): v is InstrumentId {
  return typeof v === 'string' && BY_ID.has(v);
}

export interface InstrumentGroup {
  assetClass: AssetClass;
  instruments: InstrumentDefinition[];
}

/** Instruments grouped in display order; empty groups are omitted. */
export function groupInstruments(list: readonly InstrumentDefinition[] = INSTRUMENTS): InstrumentGroup[] {
  return ASSET_CLASS_ORDER.map((assetClass) => ({ assetClass, instruments: list.filter((i) => i.assetClass === assetClass) })).filter(
    (g) => g.instruments.length > 0,
  );
}

/** Case-insensitive search over id, names, aliases and asset class. */
export function searchInstruments(query: string, list: readonly InstrumentDefinition[] = INSTRUMENTS): InstrumentDefinition[] {
  const q = query.trim().toLowerCase().replace(/[\s/-]+/g, '');
  if (!q) return [...list];
  const norm = (s: string) => s.toLowerCase().replace(/[\s/-]+/g, '');
  return list.filter((i) =>
    [i.id, i.shortName, i.name, i.displayName, i.assetClass, ...i.aliases].some((f) => norm(f).includes(q)),
  );
}
