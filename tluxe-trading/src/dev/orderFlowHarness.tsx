/**
 * DEVELOPMENT HARNESS — visual verification of the Liquidity Heatmap page with a seeded TEST DATA
 * order-flow stream (scripted provider, `info.test = true`). Served only by the dev server at
 * /orderflow-harness.html; never a production entry. 20 minutes of history are preloaded, then the
 * stream continues in real time. `?caps=noaggressor` simulates a provider without aggressor side;
 * `?depth=off` a trades-only provider (depth DATA UNAVAILABLE). `?tape=burst` = a dense trades-only TEST tape shaped
 * like the production problem case: same-millisecond sweeps through many ticks, and an hour of backlog delivered
 * AFTER newer live trades (out of exchange-time order), as a bridge's intraday replay can arrive. `?tape=sparse` = the
 * same shape with a quiet market (a trade every 1.5-10 s).
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
import type { OrderFlowMsg } from '../engines/orderFlow/types';
import { ScriptedOrderFlowProvider } from '../providers/orderFlow/testing/ScriptedOrderFlowProvider';
import { connectServices, createServices, defaultProviders } from '../services/registry';

/** TEST DATA: dense trades-only tape (seeded) - live A, then older backlog B (delivered late), then live C. */
function burstTape(sparse = false): { script: OrderFlowMsg[]; preload: number } {
  let seed = 11;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const side = () => (rnd() < 0.02 ? 'UNKNOWN' : rnd() < 0.5 ? 'BUY' : 'SELL') as 'BUY' | 'SELL' | 'UNKNOWN';
  const size = () => (rnd() < 0.03 ? 60 + Math.floor(rnd() * 240) : 1 + Math.floor(rnd() * rnd() * 25));
  let n = 0;
  const trade = (t: number, tick: number, sz: number, ag: 'BUY' | 'SELL' | 'UNKNOWN'): OrderFlowMsg => ({ type: 'trade', instrumentId: 'GC', seq: null, exchTime: t, recvTime: t + 40, price: tick / 10, size: sz, aggressor: ag, tradeId: `T${n++}` });
  const hb = (t: number): OrderFlowMsg => ({ type: 'heartbeat', instrumentId: 'GC', seq: null, exchTime: t, recvTime: t + 40, stream: 'trade' });
  const walk = (t0: number, t1: number, start: number, out: OrderFlowMsg[]) => {
    let tick = start;
    let nextHb = t0;
    for (let t = t0; t < t1; t += sparse ? 1500 + Math.floor(rnd() * 9000) : 40 + Math.floor(rnd() * 260)) {
      while (nextHb <= t) out.push(hb((nextHb += 1000)));
      if (rnd() < 0.25) tick += rnd() < 0.5 ? -1 : 1;
      if (rnd() < (sparse ? 0.02 : 0.04)) {
        // sweep: many prints in the SAME millisecond through several ticks
        const dir = rnd() < 0.5 ? -1 : 1;
        const levels = 5 + Math.floor(rnd() * 12);
        const ag = dir > 0 ? 'BUY' : 'SELL';
        for (let k = 0; k < levels; k++) for (let j = 0; j < 1 + Math.floor(rnd() * 3); j++) out.push(trade(t, tick + dir * k, 1 + Math.floor(rnd() * 12), rnd() < 0.03 ? 'UNKNOWN' : ag));
        tick += dir * (levels - 1);
      } else out.push(trade(t, tick, size(), side()));
    }
    return tick;
  };
  const A: OrderFlowMsg[] = [];
  const B: OrderFlowMsg[] = [];
  const C: OrderFlowMsg[] = [];
  const mid = walk(-3_600_000, -45_000, 41700, B); // backlog: the hour before (delivered AFTER the newer trades in A)
  const end = walk(-45_000, 0, mid, A);
  A.push(hb(0));
  walk(1, 15 * 60_000, end, C);
  B.push(hb(0)); // anchors the preload at "now"
  return { script: [...A, ...B, ...C], preload: A.length + B.length };
}

const q = new URLSearchParams(location.search);
const burst = q.get('tape') === 'burst' || q.get('tape') === 'sparse';
const tape = burst ? burstTape(q.get('tape') === 'sparse') : null;
const script = tape ? tape.script : generatedSession(45);
const caps = { ...FULL_CAPS, aggressorSide: q.get('caps') !== 'noaggressor', depth: burst || q.get('depth') === 'off' ? ('NONE' as const) : ('MBP' as const) };
const provider = new ScriptedOrderFlowProvider(script, caps, { mode: 'realtime', preload: tape ? tape.preload : Math.floor(script.length * 0.45), contract: 'TEST-GC' });
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
