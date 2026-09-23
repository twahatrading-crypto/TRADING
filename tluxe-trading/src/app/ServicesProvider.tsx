import type { ReactNode } from 'react';
import type { Services } from '../services/registry';
import { ServicesContext } from './servicesContext';

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}
