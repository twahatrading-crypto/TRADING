import { tickSizeOf } from '../../config/instruments';
import { DEFAULT_SMC_SETTINGS, SMC_TIMEFRAMES, type SmcSettings } from '../../engines/smc/config';
import { SmcEngine, type SmcInput } from '../../engines/smc/engine';
import { smcClosedOnly, type SmcDataset } from '../../engines/smc/knowledge';
import type { SmcEvent, SmcFeed, SmcSnapshot } from '../../engines/smc/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentId } from '../../types/instruments';
import type { Timeframe } from '../../types/market';
import { hleFeedOf } from '../highLowEngine/feed';
import type { InstrumentSelection } from '../instruments/InstrumentSelection';
import type { MarketDataService } from '../market/MarketDataService';
import { SmcReplaySession } from './SmcReplay';

export interface SmcState {
  instrumentId: InstrumentId;
  snapshot: SmcSnapshot | null;
  /** De-duplicated event log (engine events + DATA REVISED / STALE / RECOVERED), newest last. */
  log: SmcEvent[];
  feed: SmcFeed;
  /** Closed candles the broker revised since attach (ACCEPT + LOG). */
  revisions: number;
  /** Wall-clock time of the last analysis (ms). */
  computedAt: number | null;
}

const MAX_LOG = 1500;
type Clock = () => number;

/**
 * SMC runtime (outside React): MT5 → TLUXE bridge → MarketDataService → SmcEngine. ONE engine for the
 * ACTIVE instrument only (recreated on a symbol change, so no analysis of the previous instrument can
 * remain visible). Subscribes to D1 H4 H1 M30 M15 M5 M1 through the market service, which requests
 * history once per instrument/timeframe — no extra polling, providers or timers. Closed candles only;
 * the forming M1 bar only sets the display price.
 */
export class SmcService {
  readonly store: Store<SmcState>;
  readonly settings: SmcSettings = { ...DEFAULT_SMC_SETTINGS };
  private engine: SmcEngine | null = null;
  private unsubs: (() => void)[] = [];
  private attached: InstrumentId | null = null;
  private logMap = new Map<string, SmcEvent>();
  private lastFeed: SmcFeed | null = null;
  /** Analyses run (tests / diagnostics). */
  runs = 0;

  constructor(
    private readonly market: MarketDataService,
    private readonly instruments: InstrumentSelection,
    private readonly clock: Clock = () => Date.now(),
  ) {
    const id = this.instruments.store.getState().activeId;
    this.store = createStore<SmcState>({ instrumentId: id, snapshot: null, log: [], feed: 'DISCONNECTED', revisions: 0, computedAt: null });
  }

  start(): () => void {
    this.attach(this.instruments.store.getState().activeId);
    const stop = this.instruments.store.subscribe(() => this.attach(this.instruments.store.getState().activeId));
    return () => {
      stop();
      this.detach();
    };
  }

  /** Re-run the analysis from the loaded candles (clean rebuild; no new data request). */
  refresh(): void {
    const id = this.attached;
    if (!id) return;
    const def = this.instruments.get(id);
    if (!def) return;
    this.engine = new SmcEngine({ instrumentId: id, tickSize: tickSizeOf(def), settings: this.settings });
    this.run();
  }

  private feed(id: InstrumentId): SmcFeed {
    const m = this.market.store(id).getState();
    return hleFeedOf(m.connection, m.feed?.code ?? null);
  }

  input(id: InstrumentId): SmcInput {
    const out: SmcInput = {};
    for (const tf of SMC_TIMEFRAMES) out[tf] = smcClosedOnly(this.market.getCandles(id, tf));
    return out;
  }

  createReplay(timeframe: Timeframe, startIndex?: number, verify = true): SmcReplaySession | null {
    const id = this.attached;
    const def = id ? this.instruments.get(id) : undefined;
    if (!def) return null;
    const input = this.input(def.id);
    const candles: SmcDataset['candles'] = {};
    for (const tf of SMC_TIMEFRAMES) candles[tf] = Object.freeze((input[tf] ?? []).map((c) => Object.freeze({ ...c })));
    return new SmcReplaySession({ instrumentId: def.id, tickSize: tickSizeOf(def), settings: this.settings, candles }, timeframe, { startIndex, verify });
  }

  private attach(id: InstrumentId): void {
    if (this.attached === id) return;
    this.detach();
    this.attached = id;
    this.logMap = new Map();
    this.lastFeed = null;
    // A symbol change clears the previous instrument's analysis immediately.
    this.store.setState({ instrumentId: id, snapshot: null, log: [], feed: this.feed(id), revisions: 0, computedAt: null });
    const def = this.instruments.get(id);
    if (!def) return;
    this.engine = new SmcEngine({ instrumentId: id, tickSize: tickSizeOf(def), settings: this.settings });
    for (const tf of SMC_TIMEFRAMES) this.unsubs.push(this.market.subscribeCandles(id, tf, () => this.run()));
    this.unsubs.push(
      this.market.store(id).subscribe(() => {
        const f = this.feed(id);
        if (f !== this.lastFeed) this.run();
      }),
    );
    this.run();
  }

  private detach(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.attached = null;
    this.engine = null;
  }

  private run(): void {
    const id = this.attached;
    const e = this.engine;
    if (!id || !e) return;
    this.runs += 1;
    const m1 = this.market.getCandles(id, 'M1');
    const price = m1.length ? m1[m1.length - 1]!.close : null;
    const feed = this.feed(id);
    const r = e.update(this.input(id), { currentPrice: price });
    const snapshot = e.snapshot(feed);
    const nowSec = Math.floor(this.clock() / 1000);
    const extra: SmcEvent[] = [];
    // Broker revisions of closed candles: accepted, rebuilt deterministically — and logged, never silent.
    for (const x of r.revised) {
      extra.push({
        id: `${id}:${x.tf}:DATA REVISED:${x.time}`,
        time: snapshot.knowledgeTime ?? x.time,
        instrumentId: id,
        timeframe: x.tf,
        type: 'DATA REVISED',
        price: null,
        message: `MT5 revised the closed ${x.tf} candle of ${new Date(x.time * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC — ${x.tf} analysis rebuilt from the corrected data.`,
      });
    }
    if (r.revised.length) this.supersede(snapshot, r.revised);
    if (this.lastFeed !== null && feed !== this.lastFeed) {
      if (feed === 'STALE') extra.push({ id: `${id}:DATA STALE:${nowSec}`, time: nowSec, instrumentId: id, timeframe: null, type: 'DATA STALE', price: null, message: 'Price feed stale — SMC analysis frozen at the last closed candles.' });
      if (feed === 'LIVE') extra.push({ id: `${id}:DATA RECOVERED:${nowSec}`, time: nowSec, instrumentId: id, timeframe: null, type: 'DATA RECOVERED', price: null, message: 'Price feed live again.' });
    }
    this.lastFeed = feed;
    for (const ev of [...snapshot.events, ...extra]) if (!this.logMap.has(ev.id)) this.logMap.set(ev.id, ev);
    let log = [...this.logMap.values()].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
    if (log.length > MAX_LOG) {
      log = log.slice(log.length - MAX_LOG);
      this.logMap = new Map(log.map((x) => [x.id, x]));
    }
    this.store.setState({ instrumentId: id, snapshot, log, feed, revisions: this.store.getState().revisions + r.revised.length, computedAt: this.clock() });
  }

  /** After a revision rebuild, earlier log entries the new analysis no longer produces are kept but flagged. */
  private supersede(snapshot: SmcSnapshot, revised: { tf: Timeframe; time: number }[]): void {
    const now = new Set(snapshot.events.map((e) => e.id));
    for (const { tf, time } of revised)
      for (const [k, ev] of this.logMap)
        if (ev.timeframe === tf && ev.time > time && ev.type !== 'DATA REVISED' && !now.has(ev.id) && !ev.superseded) this.logMap.set(k, { ...ev, superseded: true });
  }
}
