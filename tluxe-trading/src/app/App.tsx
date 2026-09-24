import { LIQUIDITY_ROUTE, MODULES, ORDER_BLOCKS_ROUTE, SETTINGS_ROUTE, SR_ROUTE } from '../config/modules';
import { useHashRoute } from '../hooks/useHashRoute';
import { Dashboard } from '../components/dashboard/Dashboard';
import { ModulePage } from '../components/dashboard/ModulePage';
import { SettingsPage } from '../components/settings/SettingsPage';
import { SRPage } from '../components/sr/SRPage';
import { LiquidityPage } from '../components/liquidity/LiquidityPage';
import { OrderBlocksPage } from '../components/orderBlocks/OrderBlocksPage';
import { AppShell } from '../components/navigation/AppShell';

export function App() {
  const route = useHashRoute();

  const module = MODULES.find((m) => m.path === route);
  // One shell for every page: the sidebar and market header persist across navigation.
  return (
    <AppShell>
      {route === SR_ROUTE ? <SRPage /> : route === LIQUIDITY_ROUTE ? <LiquidityPage /> : route === ORDER_BLOCKS_ROUTE ? <OrderBlocksPage /> : route === SETTINGS_ROUTE ? <SettingsPage /> : module ? <ModulePage module={module} /> : <Dashboard />}
    </AppShell>
  );
}
