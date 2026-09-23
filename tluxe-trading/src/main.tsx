import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './app/App';
import { ServicesProvider } from './app/ServicesContext';
import { connectServices, createServices, defaultProviders } from './services/registry';

const storage = (() => {
  try {
    return localStorage;
  } catch {
    return null;
  }
})();
const services = createServices(defaultProviders(storage));
// Providers live outside React: component HMR and StrictMode never reconnect them.
const disconnect = connectServices(services);
// If this module is ever re-executed by HMR, tear down the old polling first.
import.meta.hot?.dispose(disconnect);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServicesProvider services={services}>
      <App />
    </ServicesProvider>
  </StrictMode>,
);
