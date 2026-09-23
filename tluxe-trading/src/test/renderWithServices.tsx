import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ServicesProvider } from '../app/ServicesContext';
import { connectServices, createServices, defaultProviders, type ProviderSet, type Services } from '../services/registry';

export function renderWithServices(ui: ReactElement, providers: Partial<ProviderSet> = {}) {
  const services: Services = createServices({ ...defaultProviders(), ...providers });
  connectServices(services);
  return { services, ...render(<ServicesProvider services={services}>{ui}</ServicesProvider>) };
}
