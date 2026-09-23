/**
 * DEVELOPMENT HARNESS — visual verification of the S&R UI with deterministic
 * synthetic fixture candles. Served only by the dev server at /sr-harness.html;
 * it is not an entry of the production build and must never be linked from the app.
 * The fixture provider below uses the normal MarketDataProvider interface; it
 * reports DELAYED and supplies NO quote, so nothing is presented as live prices.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import '../styles/tokens.css';
import '../styles/global.css';
import { App } from '../app/App';
import { ServicesProvider } from '../app/ServicesContext';
import { randomWalk } from '../engines/sr/fixtures/builders';
import type { MarketDataProvider, MarketDataSink } from '../services/market/MarketDataProvider';
import { connectServices, createServices, defaultProviders } from '../services/registry';
import type { InstrumentDefinition } from '../types/instruments';
import type { Timeframe } from '../types/market';
import { TIMEFRAME_SECONDS } from '../engines/sr/settings';

const SEED: Record<Timeframe, number> = { M1: 11, M5: 12, M15: 13, M30: 14, H1: 15, H4: 16, D1: 17 };
const VOL: Record<Timeframe, number> = { M1: 0.6, M5: 1.2, M15: 2, M30: 2.8, H1: 4, H4: 8, D1: 16 };

class FixtureProvider implements MarketDataProvider {
  readonly family = 'futures-feed' as const;
  readonly info = { id: 'fixture', name: 'SYNTHETIC FIXTURE — NOT MARKET DATA', declaredDelaySec: null };
  private sink: MarketDataSink | null = null;
  connect(sink: MarketDataSink) {
    this.sink = sink;
  }
  disconnect() {}
  subscribe(i: InstrumentDefinition) {
    this.sink?.connection(i.id, 'DELAYED');
  }
  unsubscribe() {}
  requestCandles(id: string, tf: Timeframe) {
    const start = id === 'SI' ? 31 : 2350;
    const scale = id === 'SI' ? 0.013 : 1;
    const step = TIMEFRAME_SECONDS[tf];
    const startTime = Math.floor(Date.now() / 1000 / step) * step - 419 * step; // last bar = current (forming) bar
    const candles = randomWalk(420, { seed: SEED[tf] + (id === 'SI' ? 100 : 0), start, vol: VOL[tf] * scale, tf, startTime });
    queueMicrotask(() => this.sink?.candles(id, tf, candles, 'replace'));
  }
}

const services = createServices({ ...defaultProviders(), price: [new FixtureProvider()] }, { storage: null });
import.meta.hot?.dispose(connectServices(services));
if (!location.hash) location.hash = '#/engines/support-resistance';

const banner = document.createElement('div');
banner.textContent = 'DEV HARNESS · SYNTHETIC FIXTURE DATA — NOT MARKET DATA · NOT PART OF PRODUCTION';
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
