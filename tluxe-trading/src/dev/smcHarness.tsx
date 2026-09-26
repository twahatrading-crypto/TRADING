/**
 * DEVELOPMENT HARNESS — visual verification of the SMC Engine page with seeded TEST DATA candles
 * (one independent synthetic series per timeframe, all ending now). Served only by the dev server at
 * /smc-harness.html; never a production entry, never market data. `?feed=stale` simulates a stale feed;
 * `?symbol=XAGUSD` a silver-priced series.
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
import { SMC_TF_SECONDS } from '../engines/smc/config';
import { prng } from '../engines/smc/fixtures/builders';
import type { MarketDataProvider, MarketDataSink } from '../services/market/MarketDataProvider';
import { connectServices, createServices, defaultProviders } from '../services/registry';
import type { InstrumentDefinition } from '../types/instruments';
import type { Candle, Timeframe } from '../types/market';

const q = new URLSearchParams(location.search);
const symbol = q.get('symbol') === 'XAGUSD' ? 'XAGUSD' : 'XAUUSD';
const base = symbol === 'XAGUSD' ? 31.2 : 2400;

/** TEST DATA: trending random walk with regime changes (swings, breaks, gaps appear naturally). */
function series(tf: Timeframe, n: number, seed: number): Candle[] {
  const r = prng(seed);
  const sec = SMC_TF_SECONDS[tf];
  const end = Math.floor(Date.now() / 1000 / sec) * sec;
  // Bar volatility grows with the timeframe but stays bounded, so every timeframe's series sits near the same price.
  const vol = base * 0.0006 * Math.min(12, Math.sqrt(sec / 60));
  let c = 0;
  let drift = 0;
  const raw: [number, number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (i % 60 === 0) drift = (r() - 0.5) * vol * 0.3;
    const open = c;
    c = open + drift + (r() - 0.5) * 2 * vol + (r() < 0.04 ? (r() - 0.5) * 6 * vol : 0);
    raw.push([open, Math.max(open, c) + r() * vol * 0.6, Math.min(open, c) - r() * vol * 0.6, c]);
  }
  // Anchor: every timeframe ends at the same current price (base).
  const shift = base - c;
  const d = symbol === 'XAGUSD' ? 3 : 2;
  return raw.map(([o, h, l, cl], i) => ({ time: end - (n - 1 - i) * sec, open: +(o + shift).toFixed(d), high: +(h + shift).toFixed(d), low: +(l + shift).toFixed(d), close: +(cl + shift).toFixed(d), volume: null, isClosed: i < n - 1 }));
}

/** Dev-only diagnostics (HMR / duplicate-subscription checks). */
const counters = { requests: 0, subscriptions: 0, connects: 0 };
(window as unknown as { __smcHarness: typeof counters }).__smcHarness = counters;

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
    this.sink?.connection(i.id, q.get('feed') === 'stale' ? 'DELAYED' : 'LIVE');
  }
  unsubscribe() {}
  requestCandles(id: string, tf: Timeframe) {
    counters.requests += 1;
    const seeds: Record<Timeframe, number> = { M1: 1, M5: 2, M15: 3, M30: 4, H1: 5, H4: 6, D1: 7 };
    const c = series(tf, 400, seeds[tf] + (symbol === 'XAGUSD' ? 100 : 0));
    queueMicrotask(() => this.sink?.candles(id, tf, c, 'replace'));
  }
}

const services = createServices({ ...defaultProviders(), price: [new TestDataProvider()] }, { storage: null });
services.instruments.select(symbol);
import.meta.hot?.dispose(connectServices(services));
if (!location.hash) location.hash = '#/engines/smc';

const banner = document.createElement('div');
banner.textContent = 'DEV HARNESS · TEST DATA — SYNTHETIC CANDLES, NOT MARKET DATA · NOT PART OF PRODUCTION';
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
