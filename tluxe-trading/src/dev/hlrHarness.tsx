/**
 * DEVELOPMENT HARNESS — visual verification of the High / Low Reversal page with the
 * deterministic multi-timeframe TEST FIXTURE (aggregated from one M1 path, so all five
 * timeframes agree). Served only by the dev server at /hlr-harness.html; not a production
 * entry. `?at=entry` (default) shows the market as it stood at ENTRY READY; `?at=end` the full run;
 * `?side=sell` the mirrored SELL fixture.
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
import { DEFAULT_HLR_SETTINGS, HLR_TIMEFRAMES } from '../engines/hlReversal/config';
import { analyzeHighLowReversal } from '../engines/hlReversal/engine';
import * as F from '../engines/hlReversal/fixtures/scenarios';
import { hlrKnownInput } from '../engines/hlReversal/knowledge';
import type { MarketDataProvider, MarketDataSink } from '../services/market/MarketDataProvider';
import { connectServices, createServices, defaultProviders } from '../services/registry';
import type { InstrumentDefinition } from '../types/instruments';
import type { Timeframe } from '../types/market';

const q = new URLSearchParams(location.search);
const full = q.get('side') === 'sell' ? F.sellReversal() : F.buyReversal();
const entry = analyzeHighLowReversal({ instrumentId: 'GC', tickSize: 0.01, candles: full }).setups.find((s) => s.entry);
const data = q.get('at') === 'end' || !entry ? full : hlrKnownInput({ instrumentId: 'GC', tickSize: 0.01, settings: { ...DEFAULT_HLR_SETTINGS }, candles: full }, entry.entry!.knownAt);

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
    const c = HLR_TIMEFRAMES.includes(tf as never) ? (data[tf as keyof typeof data] ?? []) : [];
    queueMicrotask(() => this.sink?.candles(id, tf, c.map((x) => ({ ...x, isClosed: true })), 'replace'));
  }
}

const services = createServices({ ...defaultProviders(), price: [new FixtureProvider()] }, { storage: null });
import.meta.hot?.dispose(connectServices(services));
if (!location.hash) location.hash = '#/engines/high-low-reversal';

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
