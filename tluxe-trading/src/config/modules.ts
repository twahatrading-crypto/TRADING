export type ModuleIcon = 'overview' | 'calendar' | 'journal' | 'risk' | 'engines' | 'settings';

export interface ModuleConfig {
  id: string;
  title: string;
  description: string;
  icon: ModuleIcon;
  /** Hash route; each module becomes its own page in a later phase. */
  path: string;
}

export const MODULES: ModuleConfig[] = [
  { id: 'market-overview', title: 'Market Overview', description: 'Prices, charts and global markets', icon: 'overview', path: '/market-overview' },
  { id: 'economic-calendar', title: 'Economic Calendar', description: 'Scheduled releases and impact', icon: 'calendar', path: '/economic-calendar' },
  { id: 'trading-journal', title: 'Trading Journal', description: 'Track performance and insights', icon: 'journal', path: '/trading-journal' },
  { id: 'risk-management', title: 'Risk Management', description: 'Position sizing and exposure', icon: 'risk', path: '/risk-management' },
  { id: 'engines', title: 'Engines', description: 'Strategy engine control centre', icon: 'engines', path: '/engines' },
  { id: 'settings', title: 'Settings', description: 'Providers, clocks and preferences', icon: 'settings', path: '/settings' },
];
