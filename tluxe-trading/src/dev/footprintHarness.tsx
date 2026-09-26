/**
 * DEVELOPMENT HARNESS — visual verification of the Volume Footprint page with a seeded TEST DATA exchange-trade
 * stream (scripted provider, `info.test = true`). Served only by the dev server at /footprint-harness.html; never a
 * production entry, never market data. 90 minutes of history are preloaded, then trades keep arriving in real time.
 * `?caps=noaggressor` = a provider without aggressor side (FOOTPRINT DATA UNAVAILABLE / UNKNOWN volume).
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
import { FULL_FP_CAPS, generatedStream } from '../engines/volumeFootprint/testing/stream';
import { ScriptedFootprintProvider } from '../providers/footprint/testing/ScriptedFootprintProvider';
import { connectServices, createServices, defaultProviders } from '../services/registry';

const q = new URLSearchParams(location.search);
const caps = q.get('caps') === 'noaggressor' ? { ...FULL_FP_CAPS, aggressor: 'NONE' as const } : FULL_FP_CAPS;
const t0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 90 * 60_000;
const script = generatedStream({ minutes: 240, seed: 42, t0, start: 2403.5, caps, contract: 'TEST-GCZ6' });
const provider = new ScriptedFootprintProvider(script, caps, { mode: 'realtime' });
const services = createServices({ ...defaultProviders(), footprint: provider }, { storage: null, allowTestProviders: true });
services.instruments.select('GC');
import.meta.hot?.dispose(connectServices(services));
(window as unknown as { __fpHarness: ScriptedFootprintProvider }).__fpHarness = provider;
if (!location.hash) location.hash = '#/engines/volume-footprint';

const banner = document.createElement('div');
banner.textContent = 'DEV HARNESS · TEST DATA — SYNTHETIC TRADES, NOT MARKET DATA · NOT PART OF PRODUCTION';
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
