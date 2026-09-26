export type ModuleIcon = 'overview' | 'calendar' | 'journal' | 'risk' | 'engines' | 'settings';

export interface ModuleConfig {
  id: string;
  title: string;
  description: string;
  icon: ModuleIcon;
  /** Hash route; each module becomes its own page in a later phase. */
  path: string;
}

/** Engines → Support & Resistance page. */
export const SR_ROUTE = '/engines/support-resistance';

/** Trading Strategy → Liquidity. */
export const LIQUIDITY_ROUTE = '/engines/liquidity';

/** Trading Strategy → Order Blocks. */
export const ORDER_BLOCKS_ROUTE = '/engines/order-blocks';

/** Trading Strategy → High / Low Reversal. */
export const HLR_ROUTE = '/engines/high-low-reversal';

/** Trading Strategy → High / Low Engine (separate engine; not the High / Low Reversal page). */
export const HLE_ROUTE = '/engines/high-low-engine';

/** Trading Strategy → Liquidity Heatmap (order flow; exchange Level-2 + time & sales only). */
export const HEATMAP_ROUTE = '/engines/liquidity-heatmap';
/** SMC Engine page (Smart Money Concepts market analysis; its own engine, service and UI). */
export const SMC_ROUTE = '/engines/smc';
/** Volume Profile page (POC / value area / HVN-LVN from real candle volume; analysis only). */
export const VP_ROUTE = '/engines/volume-profile';
/** Volume Footprint page (executed order flow: Bid × Ask per price from exchange trades; analysis only). */
export const FOOTPRINT_ROUTE = '/engines/volume-footprint';
/** News Analysis page (economic calendar, breaking news, event impact; analysis only). */
export const NEWS_ROUTE = '/engines/news-analysis';

/** Settings → Data Providers page. */
export const SETTINGS_ROUTE = '/settings';

export const MODULES: ModuleConfig[] = [
  { id: 'market-overview', title: 'Market Overview', description: 'Prices, charts and markets', icon: 'overview', path: '/market-overview' },
  { id: 'economic-calendar', title: 'Economic Calendar', description: 'Releases and market impact', icon: 'calendar', path: '/economic-calendar' },
  { id: 'trading-journal', title: 'Trading Journal', description: 'Trades, reviews and insights', icon: 'journal', path: '/trading-journal' },
  { id: 'risk-management', title: 'Risk Management', description: 'Position sizing and exposure', icon: 'risk', path: '/risk-management' },
  { id: 'engines', title: 'Engines', description: 'Support & Resistance engine', icon: 'engines', path: '/engines/support-resistance' },
  { id: 'settings', title: 'Settings', description: 'Providers and preferences', icon: 'settings', path: '/settings' },
];
