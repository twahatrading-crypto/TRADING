/**
 * DEVELOPMENT HARNESS — visual verification of the Liquidity Heatmap page with a seeded TEST DATA
 * order-flow stream (scripted provider, `info.test = true`). Served only by the dev server at
 * /orderflow-harness.html; never a production entry. 20 minutes of history are preloaded, then the
 * stream continues in real time. `?caps=noaggressor` simulates a provider without aggressor side;
 * `?depth=off` a trades-only provider (depth DATA UNAVAILABLE).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import '../styles/tokens.css';
import '../styles/global.css';
import { App } from '../app/App';
import { ServicesProvider } from '../app/ServicesProvider';
import { FULL_CAPS, generatedSession } from '../engines/orderFlow/testing/scenarios';
import { ScriptedOrderFlowProvider } from '../providers/orderFlow/testing/ScriptedOrderFlowProvider';
import { connectServices, createServices, defaultProviders } from '../services/registry';

const q = new URLSearchParams(location.search);
const script = generatedSession(45);
const caps = { ...FULL_CAPS, aggressorSide: q.get('caps') !== 'noaggressor', depth: q.get('depth') === 'off' ? ('NONE' as const) : ('MBP' as const) };
const provider = new ScriptedOrderFlowProvider(script, caps, { mode: 'realtime', preload: Math.floor(script.length * 0.45), contract: 'TEST-GC' });
const services = createServices({ ...defaultProviders(), orderFlow: { depth: provider, trade: provider } }, { storage: null, allowTestProviders: true });
services.instruments.select('GC');
import.meta.hot?.dispose(connectServices(services));
if (!location.hash) location.hash = '#/engines/liquidity-heatmap';

const banner = document.createElement('div');
banner.textContent = 'DEV HARNESS · TEST DATA — SYNTHETIC ORDER FLOW, NOT MARKET DATA · NOT PART OF PRODUCTION';
Object.assign(banner.style, {
  position: 'fixed', left: '0', right: '0', bottom: '0', zIndex: '9999', padding: '6px 12px', textAlign: 'center',
  font: '700 12px Inter, system-ui, sans-serif', letterSpacing: '0.12em', color: '#1b1405', background: '#e5a33b',
});
document.body.appendChild(banner);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServicesProvider services={services}>
      <App />
    </ServicesProvider>
  </StrictMode>,
);
