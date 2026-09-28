/**
 * DEVELOPMENT HARNESS — visual verification of the Liquidity Heatmap page with a seeded TEST DATA
 * order-flow stream (scripted provider, `info.test = true`). Served only by the dev server at
 * /orderflow-harness.html; never a production entry. 20 minutes of history are preloaded, then the
 * stream continues in real time. `?caps=noaggressor` simulates a provider without aggressor side;
 * `?depth=off` a trades-only provider (depth DATA UNAVAILABLE). `?tape=burst` = a dense trades-only TEST tape shaped
 * like the production problem case: same-millisecond sweeps through many ticks, and an hour of backlog delivered
 * AFTER newer live trades (out of exchange-time order), as a bridge's intraday replay can arrive. `?tape=sparse` = the
 * same shape with a quiet market (a trade every 1.5-10 s); `?tape=normal` a moderate tape (0.15-1.5 s);
 * `?tape=catchup` the moderate tape with the newest trades delivered 12 s late (restart / catch-up case).
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
import type { OrderFlowDepthProvider, OrderFlowSink, OrderFlowTradeProvider } from '../providers/orderFlow/types';
import type { InstrumentDefinition } from '../types/instruments';
import { ScriptedOrderFlowProvider } from '../providers/orderFlow/testing/ScriptedOrderFlowProvider';
import { connectServices, createServices, defaultProviders } from '../services/registry';

/** TEST DATA: dense trades-only tape (seeded) - live A, then older backlog B (delivered late), then live C. */
function burstTape(kind: 'burst' | 'sparse' | 'normal' = 'burst'): { script: OrderFlowMsg[]; preload: number; A: OrderFlowMsg[]; B: OrderFlowMsg[]; C: OrderFlowMsg[] } {
  const sparse = kind === 'sparse';
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
  // Exchange-like microstructure: a bid / ask 1 tick apart; a BUY aggressor prints at the ask, a SELL at the bid
  // (bid / ask bounce); the mid drifts a tick at a time; occasional short sweeps through a few levels.
  const walk = (t0: number, t1: number, start: number, out: OrderFlowMsg[]) => {
    let bid = start;
    let nextHb = t0;
    for (let t = t0; t < t1; t += sparse ? 1500 + Math.floor(rnd() * 9000) : kind === 'normal' ? 150 + Math.floor(rnd() * 1350) : 40 + Math.floor(rnd() * 260)) {
      while (nextHb <= t) out.push(hb((nextHb += 1000)));
      if (rnd() < 0.1) bid += rnd() < 0.5 ? -1 : 1;
      if (rnd() < 0.012) {
        // short sweep: prints in the SAME millisecond through a few levels
        const dir = rnd() < 0.5 ? -1 : 1;
        const levels = 3 + Math.floor(rnd() * 4);
        const ag = dir > 0 ? 'BUY' : 'SELL';
        const from = dir > 0 ? bid + 1 : bid;
        for (let k = 0; k < levels; k++) for (let j = 0; j < 1 + Math.floor(rnd() * 3); j++) out.push(trade(t, from + dir * k, 1 + Math.floor(rnd() * 12), rnd() < 0.03 ? 'UNKNOWN' : ag));
        bid += dir * (levels - 1);
      } else {
        const ag = side();
        const px = ag === 'BUY' ? bid + 1 : ag === 'SELL' ? bid : bid + (rnd() < 0.5 ? 0 : 1);
        out.push(trade(t, px, size(), ag));
      }
    }
    return bid;
  };
  const A: OrderFlowMsg[] = [];
  const B: OrderFlowMsg[] = [];
  const C: OrderFlowMsg[] = [];
  const cut = kind === 'normal' ? -90_000 : -45_000; // catch-up: the newest 90 s arrive late
  const mid = walk(-3_600_000, cut, 41700, B); // backlog: the hour before (delivered AFTER the newer trades in A)
  const end = walk(cut, 0, mid, A);
  A.push(hb(0));
  walk(1, 15 * 60_000, end, C);
  B.push(hb(0)); // anchors the preload at "now"
  return { script: [...A, ...B, ...C], preload: A.length + B.length, A, B, C };
}

const q = new URLSearchParams(location.search);
const tapeKind = q.get('tape');
const burst = tapeKind === 'burst' || tapeKind === 'sparse' || tapeKind === 'normal' || tapeKind === 'catchup';
const tape = burst ? burstTape(tapeKind === 'catchup' ? 'normal' : (tapeKind as 'burst' | 'sparse' | 'normal')) : null;
const caps = { ...FULL_CAPS, aggressorSide: q.get('caps') !== 'noaggressor', depth: burst || q.get('depth') === 'off' ? ('NONE' as const) : ('MBP' as const) };

/**
 * TEST DATA: ?tape=catchup - like a bridge restart: the older history and the feed clock ("now") arrive first, the
 * newest trades only 12 s later (then the stream continues live). Exercises the LOADING TRADE HISTORY state.
 */
class CatchUpTestProvider implements OrderFlowDepthProvider, OrderFlowTradeProvider {
  readonly info = { id: 'test-catchup', name: 'TEST DATA — delayed history', test: true };
  readonly stream = 'both' as const;
  private sink: OrderFlowSink | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  constructor(private readonly t: NonNullable<typeof tape>) {}
  connect(sink: OrderFlowSink): void {
    this.sink = sink;
  }
  disconnect(): void {
    this.unsubscribe();
    this.sink = null;
  }
  requestSnapshot(): void {}
  subscribe(def: InstrumentDefinition): void {
    const sink = this.sink;
    if (!sink) return;
    sink.capabilities(def.id, caps);
    sink.contract(def.id, 'TEST-GC');
    sink.status(def.id, 'depth', 'DATA_UNAVAILABLE', 'TEST: trades only');
    sink.status(def.id, 'trade', 'LIVE');
    const start = Date.now();
    const shift = (m: OrderFlowMsg): OrderFlowMsg => ({ ...m, exchTime: m.exchTime + start, recvTime: m.recvTime + start });
    for (const m of this.t.B) sink.message(shift(m)); // oldest history + a feed-clock heartbeat at "now"
    // Like the real adapter: nothing newer is emitted until the missing range has been delivered (12 s later here).
    this.timers.push(
      setTimeout(() => {
        this.t.A.forEach((m) => this.sink?.message(shift(m)));
        const live = setInterval(() => {
          while (this.t.C.length && this.t.C[0]!.exchTime <= Date.now() - start) this.sink?.message(shift(this.t.C.shift()!));
        }, 50);
        this.timers.push(live as unknown as ReturnType<typeof setTimeout>);
      }, 12_000),
    );
  }
  unsubscribe(): void {
    this.timers.forEach((x) => clearTimeout(x as never));
    this.timers.forEach((x) => clearInterval(x as never));
    this.timers = [];
  }
}

const script = tape ? tape.script : generatedSession(45);
const provider =
  tapeKind === 'catchup' && tape
    ? new CatchUpTestProvider(tape)
    : new ScriptedOrderFlowProvider(script, caps, { mode: 'realtime', preload: tape ? tape.preload : Math.floor(script.length * 0.45), contract: 'TEST-GC' });
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
