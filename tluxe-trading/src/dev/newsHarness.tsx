/**
 * DEVELOPMENT HARNESS — visual verification of the News Analysis page with scripted TEST DATA
 * providers (info.test = true, allowed only here) and synthetic XAUUSD M1 candles. Served only by the
 * dev server at /news-harness.html; never a production entry; every item is TEST DATA, not news.
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
import { m1Around } from '../engines/news/testing/fixtures';
import { ScriptedCalendarProvider, ScriptedHeadlineProvider, TEST_CALENDAR_INFO, TEST_WIRE_INFO } from '../providers/news/testing/ScriptedNewsProviders';
import type { MarketDataProvider, MarketDataSink } from '../services/market/MarketDataProvider';
import { connectServices, createServices, defaultProviders } from '../services/registry';
import type { InstrumentDefinition } from '../types/instruments';
import type { Timeframe } from '../types/market';

const MIN = 60_000;
const now = Date.now();
const released = Math.floor((now - 20 * MIN) / MIN) * MIN;
const soon = Math.floor((now + 25 * MIN) / MIN) * MIN;
const tag = 'TEST DATA — ';
const cal = new ScriptedCalendarProvider(TEST_CALENDAR_INFO, [
  { id: 'cpi', time: released, title: 'CPI m/m', country: 'US', currency: 'USD', impact: 'high', forecast: '0.3%', previous: '0.2%', actual: '0.4%' },
  { id: 'claims', time: released, title: 'Initial Jobless Claims', country: 'US', currency: 'USD', impact: 'medium', forecast: '220K', previous: '215K', actual: '241K' },
  { id: 'retail', time: soon, title: 'Retail Sales m/m', country: 'US', currency: 'USD', impact: 'high', forecast: '0.2%', previous: '0.5%' },
  { id: 'ecb', time: now + 26 * 60 * MIN, title: 'ECB Main Refinancing Rate', country: 'EU', currency: 'EUR', forecast: '2.15%', previous: '2.15%' },
  { id: 'fomc', time: now + 3 * 24 * 60 * MIN, title: 'FOMC Rate Decision', country: 'US', currency: 'USD', impact: 'high', forecast: '4.50%', previous: '4.50%' },
  { id: 'boe', time: now + 2 * 24 * 60 * MIN, title: 'BOE Bank Rate', country: 'GB', currency: 'GBP', forecast: '4.00%', previous: '4.00%' },
  { id: 'pmi', time: now - 5 * 60 * MIN, title: 'Manufacturing PMI', country: 'US', currency: 'USD', impact: 'medium', forecast: '49.5', previous: '48.9', actual: '49.5' },
]);
const wire = new ScriptedHeadlineProvider(TEST_WIRE_INFO, [
  { id: 'geo', publishedAt: now - 8 * MIN, headline: `${tag}Geopolitical escalation headline`, category: 'geopolitical', impact: 'high' },
  { id: 'metals', publishedAt: now - 90 * MIN, headline: `${tag}Exchange margin change headline`, category: 'metals', impact: 'medium' },
  { id: 'crypto', publishedAt: now - 3 * 60 * MIN, headline: `${tag}Crypto regulatory headline`, category: 'crypto', impact: 'low' },
]);
setInterval(() => wire.heartbeat(), 20_000);

class TestPriceProvider implements MarketDataProvider {
  readonly family = 'mt5' as const;
  readonly info = { id: 'test-data', name: 'TEST DATA — SYNTHETIC CANDLES', declaredDelaySec: null };
  private sink: MarketDataSink | null = null;
  connect(sink: MarketDataSink) {
    this.sink = sink;
  }
  disconnect() {}
  subscribe(i: InstrumentDefinition) {
    this.sink?.connection(i.id, 'LIVE');
  }
  unsubscribe() {}
  requestCandles(id: string, tf: Timeframe) {
    if (tf !== 'M1' || id !== 'XAUUSD') return;
    const c = m1Around(released, 90, 19, 2400, (i) => (i <= 0 ? Math.sin(i / 3) * 0.6 : -Math.min(i, 6) * 1.1 + Math.max(0, i - 8) * 0.35));
    queueMicrotask(() => this.sink?.candles(id, tf, c, 'replace'));
  }
}

const services = createServices({ ...defaultProviders(), price: [new TestPriceProvider()], newsAnalysis: { calendar: cal, breaking: wire } }, { storage: null, allowTestProviders: true });
services.instruments.select('XAUUSD');
import.meta.hot?.dispose(connectServices(services));
if (!location.hash) location.hash = '#/engines/news-analysis';

const banner = document.createElement('div');
banner.textContent = 'DEV HARNESS · TEST DATA — SYNTHETIC NEWS & CANDLES, NOT REAL NEWS · NOT PART OF PRODUCTION';
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
