import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './app/App';
import { ServicesProvider } from './app/ServicesProvider';
import { CloudRuntimeContext } from './components/cloud/cloudContext';
import { CloudSignIn } from './components/cloud/CloudSignIn';
import { IS_CLOUD } from './config/deployment';
import { fetchRuntimeConfig, sessionStatus } from './services/cloud/cloudApi';
import { startCloudRuntime } from './services/cloud/cloudRuntime';
import { connectServices, createServices, defaultProviders } from './services/registry';

const storage = (() => {
  try {
    return localStorage;
  } catch {
    return null;
  }
})();
const root = createRoot(document.getElementById('root')!);

function startApp(publicMarketData = false) {
  const services = createServices(defaultProviders(storage));
  // Providers live outside React: component HMR and StrictMode never reconnect them.
  const disconnect = connectServices(services);
  // Cloud only: gateway status stream, news notifications, alert persistence, session expiry -> sign-in again.
  // Public market-data mode (no owner login configured yet): no session, so no session-bound stream / status runtime;
  // Databento data still flows over the read-only /api/databento endpoints.
  const cloud = IS_CLOUD && !publicMarketData ? startCloudRuntime(services, { onSessionExpired: () => window.location.reload() }) : null;
  // If this module is ever re-executed by HMR, tear down the old polling first.
  import.meta.hot?.dispose(() => {
    cloud?.stop();
    disconnect();
  });
  root.render(
    <StrictMode>
      <ServicesProvider services={services}>
        <CloudRuntimeContext.Provider value={cloud}>
          <App />
        </CloudRuntimeContext.Provider>
      </ServicesProvider>
    </StrictMode>,
  );
}

if (!IS_CLOUD) {
  startApp();
} else {
  // Cloud: nothing connects (and no provider is polled) until the owner is signed in - unless the gateway reports
  // public market-data mode (login not configured yet), where only read-only market data is available.
  void fetchRuntimeConfig().then(async (rc) => {
    if (rc.publicMarketData) return startApp(true);
    const s = await sessionStatus();
    if (s === 'authenticated') startApp();
    else root.render(<CloudSignIn gatewayDown={s === 'unreachable'} onSignedIn={() => startApp()} />);
  });
}
