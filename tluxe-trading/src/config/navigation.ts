import { HLR_ROUTE, LIQUIDITY_ROUTE, ORDER_BLOCKS_ROUTE, SR_ROUTE } from './modules';

/**
 * Trading Strategy pages shown under "Trading Strategy" in the sidebar.
 *
 * To add a strategy page later: build the page, give it a route here and set
 * `route` — entries without a route render disabled ("Soon"), so unfinished
 * strategies can never be opened.
 */
export type StrategyIcon = 'sr' | 'liquidity' | 'orderBlocks' | 'hlr' | 'sweep';

export interface StrategyNavItem {
  id: string;
  label: string;
  icon: StrategyIcon;
  /** Hash route of the built page; null = not built yet (disabled). */
  route: string | null;
}

export const STRATEGY_NAV: readonly StrategyNavItem[] = [
  { id: 'support-resistance', label: 'Support & Resistance', icon: 'sr', route: SR_ROUTE },
  { id: 'liquidity', label: 'Liquidity', icon: 'liquidity', route: LIQUIDITY_ROUTE },
  { id: 'order-blocks', label: 'Order Blocks', icon: 'orderBlocks', route: ORDER_BLOCKS_ROUTE },
  { id: 'high-low-reversal', label: 'High / Low Reversal', icon: 'hlr', route: HLR_ROUTE },
  { id: 'sweep-reversal', label: 'Sweep / Reversal', icon: 'sweep', route: null },
];

export const DASHBOARD_ROUTE = '/';
