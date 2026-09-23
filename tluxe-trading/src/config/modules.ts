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

export const MODULES: ModuleConfig[] = [
  { id: 'market-overview', title: 'Market Overview', description: 'Prices, charts and markets', icon: 'overview', path: '/market-overview' },
  { id: 'economic-calendar', title: 'Economic Calendar', description: 'Releases and market impact', icon: 'calendar', path: '/economic-calendar' },
  { id: 'trading-journal', title: 'Trading Journal', description: 'Trades, reviews and insights', icon: 'journal', path: '/trading-journal' },
  { id: 'risk-management', title: 'Risk Management', description: 'Position sizing and exposure', icon: 'risk', path: '/risk-management' },
  { id: 'engines', title: 'Engines', description: 'Support & Resistance engine', icon: 'engines', path: '/engines/support-resistance' },
  { id: 'settings', title: 'Settings', description: 'Providers and preferences', icon: 'settings', path: '/settings' },
];
