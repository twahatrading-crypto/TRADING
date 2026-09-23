import { useEffect } from 'react';
import { MODULES } from '../config/modules';
import { useHashRoute } from '../hooks/useHashRoute';
import { connectServices } from '../services/registry';
import { Dashboard } from '../components/dashboard/Dashboard';
import { ModulePage } from '../components/dashboard/ModulePage';
import { useServices } from './servicesContext';

export function App() {
  const services = useServices();
  const route = useHashRoute();

  useEffect(() => connectServices(services), [services]);

  const module = MODULES.find((m) => m.path === route);
  return module ? <ModulePage module={module} /> : <Dashboard />;
}
