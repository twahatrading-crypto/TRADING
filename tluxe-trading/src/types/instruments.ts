import type { SessionDefinition } from '../utils/sessions';
import type { NewsCategory } from './news';

/** Canonical internal instrument id (e.g. "GC", "XAUUSD"). Never a provider's symbol. */
export type InstrumentId = string;

export type AssetClass = 'futures' | 'metals' | 'forex' | 'crypto' | 'indices';

export type InstrumentKind = 'future' | 'spot-otc' | 'fx-pair' | 'crypto-pair' | 'index' | 'category';

/** Data a source may supply. Anything not declared is treated as unavailable. */
export type DataCapability =
  | 'quote'
  | 'ohlcv'
  | 'trades'
  | 'level1'
  | 'level2'
  | 'marketDepth'
  | 'mbo'
  | 'mbp'
  | 'historicalCandles';

/** Price feeds (quotes/candles) and depth feeds (order book) are independent sources. */
export type ProviderRole = 'price' | 'depth';

/**
 * Class of adapter that can serve an instrument. Concrete providers (a specific
 * broker's MT5 server, a specific futures vendor, Bookmap) belong to a family.
 */
export type ProviderFamily = 'futures-feed' | 'mt5' | 'depth-feed' | 'crypto-feed' | 'index-feed';

export interface ProviderMapping {
  family: ProviderFamily;
  role: ProviderRole;
  /**
   * Exact provider symbol when it is fixed and known. Null means the adapter
   * must discover and validate it (e.g. MT5 broker symbols vary: GOLD, XAUUSD.a…).
   */
  symbol: string | null;
  /** Hints used only to search a provider's discovered symbol list. Never used unvalidated. */
  discoveryHints: string[];
  /** Upper bound of what this source can supply for the instrument. */
  capabilities: DataCapability[];
  note?: string;
}

/** For category entries (e.g. NASDAQ) that resolve to a concrete instrument per provider. */
export interface InstrumentVariant {
  label: string;
  kind: InstrumentKind;
  family: ProviderFamily;
}

export interface InstrumentDefinition {
  id: InstrumentId;
  /** e.g. "GC — COMEX Gold Futures" */
  displayName: string;
  /** e.g. "GC" */
  shortName: string;
  /** e.g. "COMEX Gold Futures" */
  name: string;
  assetClass: AssetClass;
  kind: InstrumentKind;
  /** Listing exchange for exchange-traded instruments; null for OTC/broker/multi-venue. */
  exchange: string | null;
  /** Human description of where prices come from, e.g. "MT5 broker feed". */
  venue: string;
  currency: string;
  pricePrecision: number;
  /** Minimum price increment when known (exchange contract spec). Otherwise 10^-pricePrecision is used. */
  tickSize?: number;
  /** False for categories that are not themselves a tradable instrument. */
  tradable: boolean;
  aliases: string[];
  providerMappings: ProviderMapping[];
  /** Union of capabilities across all mapped sources (derived). */
  capabilities: DataCapability[];
  /** Regular trading hours, '24/7', or null when they depend on the provider/instrument variant. */
  tradingHours: SessionDefinition | '24/7' | null;
  newsTopics: NewsCategory[];
  /** Currencies whose economic releases are relevant. */
  calendarCurrencies: string[];
  fx?: { base: string; quote: string };
  variants?: InstrumentVariant[];
}

export const ASSET_CLASS_ORDER: readonly AssetClass[] = ['futures', 'metals', 'forex', 'crypto', 'indices'];

export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  futures: 'Futures',
  metals: 'Metals',
  forex: 'Forex',
  crypto: 'Crypto',
  indices: 'Indices',
};

export const DEPTH_CAPABILITIES: readonly DataCapability[] = ['level2', 'marketDepth', 'mbo', 'mbp'];
