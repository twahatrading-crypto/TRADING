import { useEffect } from 'react';
import { MODULES, SETTINGS_ROUTE, SR_ROUTE } from '../config/modules';
import { useHashRoute } from '../hooks/useHashRoute';
import { connectServices } from '../services/registry';
import { Dashboard } from '../components/dashboard/Dashboard';
import { ModulePage } from '../components/dashboard/ModulePage';
import { SettingsPage } from '../components/settings/SettingsPage';
import { SRPage } from '../components/sr/SRPage';
import { useServices } from './servicesContext';

export function App() {
  const services = useServices();
  const route = useHashRoute();

  useEffect(() => connectServices(services), [services]);

  if (route === SR_ROUTE) return <SRPage />;
  if (route === SETTINGS_ROUTE) return <SettingsPage />;
  const module = MODULES.find((m) => m.path === route);
  return module ? <ModulePage module={module} /> : <Dashboard />;
}
