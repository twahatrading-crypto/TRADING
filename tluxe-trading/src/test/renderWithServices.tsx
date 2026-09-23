import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ServicesProvider } from '../app/ServicesProvider';
import {
  connectServices,
  createServices,
  defaultProviders,
  type ProviderSet,
  type ServiceOptions,
  type Services,
} from '../services/registry';
import { memoryStorage } from './providers';

/** Renders with real services wired to (by default) no providers and isolated storage. */
export function renderWithServices(ui: ReactElement, providers: Partial<ProviderSet> = {}, opts: ServiceOptions = {}) {
  const storage = opts.storage === undefined ? memoryStorage() : opts.storage;
  const services: Services = createServices({ ...defaultProviders(), ...providers }, { ...opts, storage });
  connectServices(services);
  return { services, storage, ...render(<ServicesProvider services={services}>{ui}</ServicesProvider>) };
}
