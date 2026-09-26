import { HEATMAP_ROUTE, HLE_ROUTE, HLR_ROUTE, LIQUIDITY_ROUTE, MODULES, NEWS_ROUTE, ORDER_BLOCKS_ROUTE, SETTINGS_ROUTE, SMC_ROUTE, SR_ROUTE } from '../config/modules';
import { useHashRoute } from '../hooks/useHashRoute';
import { Dashboard } from '../components/dashboard/Dashboard';
import { ModulePage } from '../components/dashboard/ModulePage';
import { SettingsPage } from '../components/settings/SettingsPage';
import { SRPage } from '../components/sr/SRPage';
import { LiquidityPage } from '../components/liquidity/LiquidityPage';
import { OrderBlocksPage } from '../components/orderBlocks/OrderBlocksPage';
import { HLRPage } from '../components/hlReversal/HLRPage';
import { HighLowEnginePage } from '../components/highLowEngine/HighLowEnginePage';
import { LiquidityHeatmapPage } from '../pages/LiquidityHeatmapPage';
import { SmcPage } from '../components/smc/SmcPage';
import { NewsAnalysisPage } from '../pages/NewsAnalysisPage';
import { AppShell } from '../components/navigation/AppShell';

export function App() {
  const route = useHashRoute();

  const module = MODULES.find((m) => m.path === route);
  // One shell for every page: the sidebar and market header persist across navigation.
  return (
    <AppShell>
      {route === SR_ROUTE ? <SRPage /> : route === LIQUIDITY_ROUTE ? <LiquidityPage /> : route === ORDER_BLOCKS_ROUTE ? <OrderBlocksPage /> : route === HLR_ROUTE ? <HLRPage /> : route === HLE_ROUTE ? <HighLowEnginePage /> : route === HEATMAP_ROUTE ? <LiquidityHeatmapPage /> : route === SMC_ROUTE ? <SmcPage /> : route === NEWS_ROUTE ? <NewsAnalysisPage /> : route === SETTINGS_ROUTE ? <SettingsPage /> : module ? <ModulePage module={module} /> : <Dashboard />}
    </AppShell>
  );
}
