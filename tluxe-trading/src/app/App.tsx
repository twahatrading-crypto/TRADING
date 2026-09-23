import { MODULES, SETTINGS_ROUTE, SR_ROUTE } from '../config/modules';
import { useHashRoute } from '../hooks/useHashRoute';
import { Dashboard } from '../components/dashboard/Dashboard';
import { ModulePage } from '../components/dashboard/ModulePage';
import { SettingsPage } from '../components/settings/SettingsPage';
import { SRPage } from '../components/sr/SRPage';

export function App() {
  const route = useHashRoute();

  if (route === SR_ROUTE) return <SRPage />;
  if (route === SETTINGS_ROUTE) return <SettingsPage />;
  const module = MODULES.find((m) => m.path === route);
  return module ? <ModulePage module={module} /> : <Dashboard />;
}
