/**
 * DEVELOPMENT HARNESS — visual verification of the Volume Profile page with seeded TEST DATA candles and
 * TEST DATA tick volume (one M5 walk aggregated upwards, ending now). Served only by the dev server at
 * /vp-harness.html; never a production entry, never market data. `?symbol=XAGUSD` = silver-priced series,
 * `?symbol=GC` = the GC page (no exchange-volume provider → GC VOLUME DATA UNAVAILABLE).
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
import { aggregate, m5Walk } from '../engines/volumeProfile/fixtures/builders';
import type { MarketDataProvider, MarketDataSink } from '../services/market/MarketDataProvider';
import { connectServices, createServices, defaultProviders } from '../services/registry';
import type { InstrumentDefinition } from '../types/instruments';
import type { Candle, Timeframe } from '../types/market';

const q = new URLSearchParams(location.search);
const symbol = q.get('symbol') === 'XAGUSD' ? 'XAGUSD' : q.get('symbol') === 'GC' ? 'GC' : 'XAUUSD';
const silver = symbol === 'XAGUSD';
const DAYS = 12;
const end = Math.floor(Date.now() / 1000 / 300) * 300;
const m5 = m5Walk(DAYS, { seed: silver ? 77 : 7, start: silver ? 31.2 : 2400, vol: silver ? 0.012 : 0.6, t0: end - DAYS * 86400, center: (d) => (silver ? 31.2 + (d % 5) * 0.08 : 2400 + (d % 5) * 4) });
const TF_SEC: Record<Timeframe, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
const last = m5[m5.length - 1]!.time + 300;
const byTf = (tf: Timeframe): Candle[] => (tf === 'M1' ? [] : tf === 'M5' ? m5 : aggregate(m5, tf)).map((c) => ({ ...c, isClosed: c.time + TF_SEC[tf] <= last }));

/** Dev-only diagnostics (HMR / duplicate-subscription checks). */
const counters = { requests: 0, subscriptions: 0, connects: 0 };
(window as unknown as { __vpHarness: typeof counters }).__vpHarness = counters;

class TestDataProvider implements MarketDataProvider {
  readonly family = 'mt5' as const;
  readonly info = { id: 'test-data', name: 'TEST DATA — SYNTHETIC, NOT MARKET DATA', declaredDelaySec: null };
  private sink: MarketDataSink | null = null;
  connect(sink: MarketDataSink) {
    counters.connects += 1;
    this.sink = sink;
  }
  disconnect() {}
  subscribe(i: InstrumentDefinition) {
    counters.subscriptions += 1;
    this.sink?.connection(i.id, 'LIVE');
  }
  unsubscribe() {}
  requestCandles(id: string, tf: Timeframe) {
    counters.requests += 1;
    const c = byTf(tf);
    queueMicrotask(() => this.sink?.candles(id, tf, c, 'replace'));
  }
}

const services = createServices({ ...defaultProviders(), price: [new TestDataProvider()] }, { storage: null });
services.instruments.select(symbol);
import.meta.hot?.dispose(connectServices(services));
if (!location.hash) location.hash = '#/engines/volume-profile';

const banner = document.createElement('div');
banner.textContent = 'DEV HARNESS · TEST DATA — SYNTHETIC CANDLES + SYNTHETIC TICK VOLUME, NOT MARKET DATA · NOT PART OF PRODUCTION';
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
