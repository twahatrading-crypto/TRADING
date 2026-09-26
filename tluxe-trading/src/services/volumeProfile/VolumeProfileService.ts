import { tickSizeOf } from '../../config/instruments';
import { confluence } from '../../engines/volumeProfile/confluence';
import { DEFAULT_VP_SETTINGS, VP_TIMEFRAMES, type VPSettings } from '../../engines/volumeProfile/config';
import { VolumeProfileEngine, type VPInput } from '../../engines/volumeProfile/engine';
import { vpClosedOnly, type VPDataset } from '../../engines/volumeProfile/knowledge';
import { vpScore } from '../../engines/volumeProfile/score';
import type { ConfluenceItem, VPEvent, VPScore, VPSnapshot, VolumeProfile } from '../../engines/volumeProfile/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentId } from '../../types/instruments';
import type { Timeframe } from '../../types/market';
import { hleFeedOf } from '../highLowEngine/feed';
import type { InstrumentSelection } from '../instruments/InstrumentSelection';
import type { MarketDataService } from '../market/MarketDataService';
import type { SmcService } from '../smc/SmcService';
import type { SRService } from '../sr/SRService';
import { VPReplaySession } from './VPReplay';

export interface VPState {
  instrumentId: InstrumentId;
  snapshot: VPSnapshot | null;
  confluence: ConfluenceItem[];
  score: VPScore | null;
  log: VPEvent[];
  feed: 'LIVE' | 'STALE' | 'DISCONNECTED';
  revisions: number;
  computedAt: number | null;
}
const MAX_LOG = 1500;

/**
 * Volume Profile runtime (outside React). ONE engine for the ACTIVE instrument (recreated on a symbol
 * change). Candles come from the existing MarketDataService subscriptions (history is requested once
 * per instrument / timeframe — no extra polling). Confluence reads the SMC and S&R services' published
 * snapshots READ-ONLY (never their internals, never mutated).
 */
export class VolumeProfileService {
  readonly store: Store<VPState>;
  readonly settings: VPSettings = { ...DEFAULT_VP_SETTINGS };
  private engine: VolumeProfileEngine | null = null;
  private attached: InstrumentId | null = null;
  private unsubs: (() => void)[] = [];
  private logMap = new Map<string, VPEvent>();
  runs = 0;

  constructor(
    private readonly market: MarketDataService,
    private readonly instruments: InstrumentSelection,
    private readonly smc: SmcService,
    private readonly sr: SRService,
    private readonly clock: () => number = () => Date.now(),
  ) {
    const id = this.instruments.store.getState().activeId;
    this.store = createStore<VPState>({ instrumentId: id, snapshot: null, confluence: [], score: null, log: [], feed: 'DISCONNECTED', revisions: 0, computedAt: null });
  }

  start(): () => void {
    this.attach(this.instruments.store.getState().activeId);
    const stop = this.instruments.store.subscribe(() => this.attach(this.instruments.store.getState().activeId));
    return () => {
      stop();
      this.detach();
    };
  }

  input(id: InstrumentId): VPInput {
    const out: VPInput = {};
    for (const tf of VP_TIMEFRAMES) out[tf] = vpClosedOnly(this.market.getCandles(id, tf));
    return out;
  }
  private ctx(id: InstrumentId) {
    const def = this.instruments.get(id);
    return { kind: def?.kind ?? 'unknown', exchange: def?.exchange ?? null };
  }
  /** Visible / fixed range profile on demand (engine output, never computed in React). */
  rangeProfile(tf: Timeframe, from: number, to: number, label: string): VolumeProfile | null {
    return this.engine?.rangeProfile(tf, from, to, label) ?? null;
  }
  refresh(): void {
    const id = this.attached;
    const def = id ? this.instruments.get(id) : undefined;
    if (!id || !def) return;
    this.engine = new VolumeProfileEngine({ instrumentId: id, tickSize: tickSizeOf(def), instrument: this.ctx(id), settings: this.settings });
    this.run();
  }
  createReplay(tf: Timeframe, startIndex?: number): VPReplaySession | null {
    const id = this.attached;
    const def = id ? this.instruments.get(id) : undefined;
    if (!id || !def) return null;
    const input = this.input(id);
    const candles: VPDataset['candles'] = {};
    for (const t of VP_TIMEFRAMES) candles[t] = Object.freeze((input[t] ?? []).map((c) => Object.freeze({ ...c })));
    return new VPReplaySession({ instrumentId: id, tickSize: tickSizeOf(def), instrument: this.ctx(id), settings: this.settings, candles }, tf, { startIndex, verify: true });
  }

  private feed(id: InstrumentId): VPState['feed'] {
    const m = this.market.store(id).getState();
    return hleFeedOf(m.connection, m.feed?.code ?? null);
  }

  private attach(id: InstrumentId): void {
    if (this.attached === id) return;
    this.detach();
    this.attached = id;
    this.logMap = new Map();
    this.store.setState({ instrumentId: id, snapshot: null, confluence: [], score: null, log: [], feed: this.feed(id), revisions: 0, computedAt: null });
    const def = this.instruments.get(id);
    if (!def) return;
    this.engine = new VolumeProfileEngine({ instrumentId: id, tickSize: tickSizeOf(def), instrument: this.ctx(id), settings: this.settings });
    for (const tf of VP_TIMEFRAMES) this.unsubs.push(this.market.subscribeCandles(id, tf, () => this.run()));
    // Read-only confluence refresh when the other engines publish (their state is never touched).
    this.unsubs.push(this.smc.store.subscribe(() => this.recombine()));
    this.unsubs.push(this.sr.store(id).subscribe(() => this.recombine()));
    let lastFeed = this.feed(id);
    this.unsubs.push(
      this.market.store(id).subscribe(() => {
        const f = this.feed(id);
        if (f === lastFeed) return;
        lastFeed = f;
        this.store.setState({ feed: f });
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
    const r = e.update(this.input(id), { currentPrice: m1.length ? m1[m1.length - 1]!.close : null });
    const snapshot = e.snapshot();
    const extra: VPEvent[] = r.revised.map((x) => ({
      id: `${id}:DATA REVISED:${x.tf}:${x.time}`,
      time: snapshot.knowledgeTime ?? x.time,
      instrumentId: id,
      type: 'DATA REVISED',
      price: null,
      profile: x.tf,
      message: `MT5 revised the closed ${x.tf} candle of ${new Date(x.time * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC — profiles rebuilt from the corrected data.`,
    }));
    if (r.revised.length) {
      const now = new Set(snapshot.events.map((x) => x.id));
      const from = Math.min(...r.revised.map((x) => x.time));
      for (const [k, ev] of this.logMap) if (ev.time > from && ev.type !== 'DATA REVISED' && !now.has(ev.id) && !ev.superseded) this.logMap.set(k, { ...ev, superseded: true });
    }
    for (const ev of [...snapshot.events, ...extra]) if (!this.logMap.has(ev.id)) this.logMap.set(ev.id, ev);
    let log = [...this.logMap.values()].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
    if (log.length > MAX_LOG) {
      log = log.slice(log.length - MAX_LOG);
      this.logMap = new Map(log.map((x) => [x.id, x]));
    }
    this.store.setState({ instrumentId: id, snapshot, log, feed: this.feed(id), revisions: this.store.getState().revisions + r.revised.length, computedAt: this.clock() });
    this.recombine();
  }

  /** Confluence + score from the current VP snapshot and the other engines' PUBLISHED snapshots. */
  private recombine(): void {
    const id = this.attached;
    const snap = this.store.getState().snapshot;
    if (!id || !snap) return;
    const smcState = this.smc.store.getState();
    const smcSnap = smcState.instrumentId === id ? smcState.snapshot : null;
    const srMulti = this.sr.store(id).getState().multi;
    const conf = confluence(snap, smcSnap, srMulti?.zones ?? null, this.settings.confluenceAtr);
    this.store.setState({ confluence: conf, score: vpScore(snap, conf, smcSnap) });
  }
}
