import { TIMEFRAMES } from '../../config/instrument';
import { INSTRUMENTS } from '../../config/instruments';
import { UPCOMING_WINDOW_MS } from '../../config/sessions';
import { TIMEFRAME_SECONDS } from '../../engines/sr/settings';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentDefinition, InstrumentId, ProviderMapping } from '../../types/instruments';
import type { FeedStatusCode, ProviderFeedDetail, ProviderSymbolMeta, Timeframe } from '../../types/market';
import { getSessionState } from '../../utils/sessions';
import { validateCandles } from '../market/integrity';
import type { MarketDataProvider, MarketDataSink } from '../market/MarketDataProvider';
import { findMapping, resolveProviderSymbol, type ResolutionTier, type SymbolResolution } from '../market/symbolMapping';
import { BridgeOfflineError, BridgeResponseError, Mt5BridgeClient } from './client';
import type { Mt5Config } from './config';
import { connectionOf, freshnessCode } from './freshness';
import { barToCandle, invertCandle } from './normalizeMt5';
import type { BridgeHealth, BridgeSymbol } from './protocol';

export interface Mt5Resolution {
  instrumentId: InstrumentId;
  displayName: string;
  status: 'resolved' | 'ambiguous' | 'not-found' | 'not-mapped' | 'needs-discovery';
  providerSymbol: string | null;
  tier: ResolutionTier | null;
  candidates: string[];
  inverted: boolean;
  note: string | null;
}

export interface Mt5ProviderState {
  attempted: boolean;
  /** Local receipt time of the last successful health response (ms). */
  heartbeatAt: number | null;
  bridgeVersion: string | null;
  startedAtMs: number | null;
  terminal: BridgeHealth['terminal'] | null;
  account: BridgeHealth['account'];
  time: BridgeHealth['time'] | null;
  error: { code: string; message: string } | null;
  symbolCount: number | null;
  resolutions: Mt5Resolution[];
  /** Broker symbols that MIGHT be COMEX futures. Reported only — never auto-mapped to GC/SI. */
  futuresCandidates: { name: string; path: string; description: string }[];
  lastDiscoveryAt: number | null;
  reconnects: number;
}

interface Runtime {
  resolution: SymbolResolution | null;
  providerSymbol: string | null;
  inverted: boolean;
  meta: ProviderSymbolMeta | null;
  loaded: Set<Timeframe>;
  needsResync: boolean;
  /** Reloading history after an outage: never reported LIVE until it completes (a 3-bar poll cannot fill a hole). */
  resyncing: boolean;
  history: Partial<Record<Timeframe, { count: number; limited: boolean; lastClosed: number }>>;
  lastCandleAt: Partial<Record<Timeframe, number>>;
  lastClosedAt: number | null;
  lastQuoteAt: number | null;
  prevDayClose: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  realVolume: boolean | null;
  quarantined: number;
  gaps: number;
  error: { code: string; message: string } | null;
}

type BridgeApi = Pick<Mt5BridgeClient, 'health' | 'symbols' | 'quote' | 'rates'>;

const newRuntime = (): Runtime => ({
  resolution: null,
  providerSymbol: null,
  inverted: false,
  meta: null,
  loaded: new Set(),
  needsResync: false,
  resyncing: false,
  history: {},
  lastCandleAt: {},
  lastClosedAt: null,
  lastQuoteAt: null,
  prevDayClose: null,
  dayHigh: null,
  dayLow: null,
  realVolume: null,
  quarantined: 0,
  gaps: 0,
  error: null,
});

const FUTURES_RE = /^(M?GC|SI|SIL|QO|QI)([FGHJKMNQUVXZ]\d{1,2})?([._\-#].*)?$/i;

const errOf = (e: unknown) =>
  e instanceof BridgeResponseError
    ? { code: e.code, message: e.message }
    : e instanceof BridgeOfflineError
      ? { code: 'MT5_BRIDGE_OFFLINE', message: e.message }
      : { code: 'ERROR', message: e instanceof Error ? e.message : String(e) };

/**
 * MetaTrader 5 price/candle provider (family "mt5").
 * Talks only to the private TLUXE bridge; never to MT5 directly.
 * Price data ONLY — it never reports order-book depth.
 */
export class Mt5Provider implements MarketDataProvider {
  readonly family = 'mt5' as const;
  readonly info = { id: 'mt5', name: 'MT5', declaredDelaySec: null };
  readonly state: Store<Mt5ProviderState>;

  private sink: MarketDataSink | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private symbols: BridgeSymbol[] | null = null;
  private readonly requested = new Map<InstrumentId, Set<Timeframe>>();
  private readonly runtimes = new Map<InstrumentId, Runtime>();
  private active: { def: InstrumentDefinition; mapping: ProviderMapping } | null = null;
  private readonly busy = { health: false, quote: false, candles: false };
  private readonly client: BridgeApi;

  constructor(
    private readonly cfg: Mt5Config,
    opts: { client?: BridgeApi; now?: () => number; instruments?: readonly InstrumentDefinition[]; autoStart?: boolean } = {},
  ) {
    this.client = opts.client ?? new Mt5BridgeClient(cfg.bridgeUrl, cfg.token, cfg.requestTimeoutMs);
    this.now = opts.now ?? Date.now;
    this.instruments = opts.instruments ?? INSTRUMENTS;
    this.autoStart = opts.autoStart ?? true;
    this.state = createStore<Mt5ProviderState>({
      attempted: false,
      heartbeatAt: null,
      bridgeVersion: null,
      startedAtMs: null,
      terminal: null,
      account: null,
      time: null,
      error: null,
      symbolCount: null,
      resolutions: [],
      futuresCandidates: [],
      lastDiscoveryAt: null,
      reconnects: 0,
    });
  }

  private readonly now: () => number;
  private readonly instruments: readonly InstrumentDefinition[];
  private readonly autoStart: boolean;

  /* ------------------------------ lifecycle ------------------------------ */

  connect(sink: MarketDataSink): void {
    this.sink = sink;
    this.disconnect(); // idempotent: never stack a second set of polling timers
    if (!this.autoStart) return;
    void this.pollHealth();
    this.timers.push(
      setInterval(() => void this.pollHealth(), this.cfg.healthMs),
      setInterval(() => void this.pollQuote(), this.cfg.quoteMs),
      setInterval(() => void this.pollCandles(), this.cfg.candleMs),
    );
  }

  disconnect(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  subscribe(def: InstrumentDefinition, mapping: ProviderMapping): void {
    this.active = { def, mapping };
    const rt = this.rt(def.id);
    if (rt.loaded.size) rt.needsResync = true; // fill the gap since it was last streamed
    void this.resolveActive();
    this.emit(def.id);
  }

  unsubscribe(id: InstrumentId): void {
    if (this.active?.def.id !== id) return;
    this.active = null;
    // Not streaming any more: never leave it looking LIVE.
    this.sink?.connection(id, 'DISCONNECTED', null);
  }

  requestCandles(id: InstrumentId, tf: Timeframe): void {
    let set = this.requested.get(id);
    if (!set) this.requested.set(id, (set = new Set()));
    set.add(tf);
    const rt = this.rt(id);
    if (this.active?.def.id === id && rt.providerSymbol && !rt.loaded.has(tf)) void this.loadHistory(id, tf, this.cfg.historyBars, 'replace');
  }

  private rt(id: InstrumentId): Runtime {
    let r = this.runtimes.get(id);
    if (!r) this.runtimes.set(id, (r = newRuntime()));
    return r;
  }

  /* -------------------------------- health -------------------------------- */

  async pollHealth(): Promise<void> {
    if (this.busy.health) return;
    this.busy.health = true;
    try {
      const h = await this.client.health();
      const prev = this.state.getState();
      const restarted = prev.startedAtMs !== null && prev.startedAtMs !== h.bridge.startedAtMs;
      const wasDown =
        prev.attempted && (prev.heartbeatAt === null || this.now() - prev.heartbeatAt > this.cfg.heartbeatStaleMs || prev.terminal?.state !== 'CONNECTED');
      this.state.setState({
        attempted: true,
        heartbeatAt: this.now(),
        bridgeVersion: h.bridge.version,
        startedAtMs: h.bridge.startedAtMs,
        terminal: h.terminal,
        account: h.account,
        time: h.time,
        error: h.error,
        reconnects: prev.reconnects + (restarted || (wasDown && h.terminal.state === 'CONNECTED') ? 1 : 0),
      });
      if (h.terminal.state === 'CONNECTED' && (this.symbols === null || restarted || wasDown)) {
        // Reconnect path: verify terminal → rediscover/validate symbols → resync history → live.
        if (restarted || wasDown) this.runtimes.forEach((r) => r.loaded.size && (r.needsResync = true));
        await this.discover();
        await this.resolveActive();
      }
    } catch (e) {
      this.state.setState({ attempted: true, error: errOf(e) });
    } finally {
      this.busy.health = false;
      if (this.active) this.emit(this.active.def.id);
    }
  }

  private async discover(): Promise<void> {
    const r = await this.client.symbols();
    this.symbols = r.symbols;
    const names = r.symbols.map((s) => s.name);
    const resolutions: Mt5Resolution[] = this.instruments.map((def) => {
      const base = { instrumentId: def.id, displayName: def.displayName, providerSymbol: null, tier: null, candidates: [], inverted: false };
      if (!findMapping(def, 'mt5')) {
        const note =
          def.kind === 'future'
            ? 'COMEX futures: not mapped to MT5 prices (requires a genuine futures feed).'
            : def.kind === 'category'
              ? 'Category: choose a specific instrument variant.'
              : 'No MT5 mapping.';
        return { ...base, status: 'not-mapped', note };
      }
      const res = resolveProviderSymbol(def, 'mt5', { available: names, overrides: this.cfg.overrides });
      if (res.status === 'resolved') {
        return { ...base, status: 'resolved', providerSymbol: res.providerSymbol, tier: res.tier, candidates: res.alternatives, inverted: res.inverted, note: null };
      }
      if (res.status === 'ambiguous') return { ...base, status: 'ambiguous', tier: res.tier, candidates: res.candidates, note: 'Several plausible broker symbols — set an override.' };
      return { ...base, status: res.status === 'not-mapped' ? 'not-mapped' : 'not-found', note: 'Not offered by this broker/terminal.' };
    });
    this.state.setState({
      symbolCount: r.count,
      resolutions,
      futuresCandidates: r.symbols
        .filter((s) => FUTURES_RE.test(s.name) || /COMEX|NYMEX|CME/i.test(s.path))
        .map((s) => ({ name: s.name, path: s.path, description: s.description })),
      lastDiscoveryAt: this.now(),
    });
  }

  private async resolveActive(): Promise<void> {
    const a = this.active;
    if (!a || !this.symbols) return;
    const id = a.def.id;
    const rt = this.rt(id);
    const res = resolveProviderSymbol(a.def, 'mt5', { available: this.symbols.map((s) => s.name), overrides: this.cfg.overrides });
    rt.resolution = res;
    if (res.status !== 'resolved') {
      rt.providerSymbol = null;
      return;
    }
    if (rt.providerSymbol !== res.providerSymbol || rt.inverted !== res.inverted) {
      Object.assign(rt, newRuntime(), { resolution: res });
    }
    rt.providerSymbol = res.providerSymbol;
    rt.inverted = res.inverted;
    const s = this.symbols.find((x) => x.name === res.providerSymbol);
    rt.meta = s
      ? { description: s.description, digits: s.digits, point: s.point, tickSize: s.tickSize, contractSize: s.contractSize, tradeMode: s.tradeMode, spreadFloat: s.spreadFloat }
      : null;
    this.sink?.capabilities(id, ['quote', 'ohlcv', 'level1', 'historicalCandles']);
    const resync = rt.needsResync;
    if (resync) {
      rt.resyncing = true;
      this.emit(id);
    }
    try {
      for (const tf of this.requested.get(id) ?? []) {
        if (!rt.loaded.has(tf)) await this.loadHistory(id, tf, this.cfg.historyBars, 'replace');
        else if (resync) {
          // Deterministic recovery: fetch enough bars to cover the whole outage; beyond the history window, reload it all.
          const last = rt.history[tf]?.lastClosed ?? 0;
          const gap = last ? Math.ceil((this.now() / 1000 - last) / TIMEFRAME_SECONDS[tf]) + 5 : Infinity;
          if (gap > this.cfg.historyBars) await this.loadHistory(id, tf, this.cfg.historyBars, 'replace');
          else await this.loadHistory(id, tf, Math.max(this.cfg.resyncBars, gap), 'upsert');
        }
      }
      rt.needsResync = false;
    } finally {
      rt.resyncing = false;
    }
  }

  /* --------------------------------- data --------------------------------- */

  private async loadHistory(id: InstrumentId, tf: Timeframe, count: number, mode: 'replace' | 'upsert'): Promise<void> {
    const rt = this.rt(id);
    const sym = rt.providerSymbol;
    if (!sym || !this.sink) return;
    try {
      const r = await this.client.rates(sym, tf, count);
      if (this.active?.def.id !== id || rt.providerSymbol !== sym) return; // switched meanwhile: drop, never mix
      let candles = r.bars.map((b) => barToCandle(b, { instrumentId: id, providerSymbol: sym, timeframe: tf }));
      if (rt.inverted) candles = candles.map(invertCandle);
      const { candles: valid, report } = validateCandles(candles, { tfSeconds: TIMEFRAME_SECONDS[tf], nowSec: Math.floor(this.now() / 1000) });
      this.sink.candles(id, tf, valid, mode);

      const closed = valid.filter((c) => c.isClosed);
      const prev = rt.history[tf];
      const lastClosed = closed.length ? closed[closed.length - 1]!.time : (prev?.lastClosed ?? 0);
      rt.history[tf] =
        mode === 'replace' || !prev
          ? { count: closed.length, limited: r.historyLimited, lastClosed }
          : { count: prev.count + closed.filter((c) => c.time > prev.lastClosed).length, limited: prev.limited, lastClosed: Math.max(prev.lastClosed, lastClosed) };
      rt.loaded.add(tf);
      const newest = valid[valid.length - 1];
      if (newest) rt.lastCandleAt[tf] = newest.time * 1000;
      if (closed.length) rt.lastClosedAt = Math.max(rt.lastClosedAt ?? 0, lastClosed * 1000);
      rt.realVolume = (rt.realVolume ?? false) || r.realVolumeAvailable;
      rt.quarantined += report.quarantined.length;
      const realGaps = report.gaps.filter((g) => !g.weekend).length;
      rt.gaps = mode === 'replace' ? realGaps : rt.gaps + realGaps;
      if (tf === 'D1') {
        const lastClosedDay = closed[closed.length - 1];
        if (lastClosedDay) rt.prevDayClose = lastClosedDay.close;
        const forming = newest && !newest.isClosed ? newest : null;
        rt.dayHigh = forming?.high ?? null;
        rt.dayLow = forming?.low ?? null;
      }
      rt.error = null;
    } catch (e) {
      rt.error = errOf(e);
    } finally {
      this.emit(id);
    }
  }

  async pollQuote(): Promise<void> {
    const a = this.active;
    if (this.busy.quote || !a) return;
    const id = a.def.id;
    const rt = this.rt(id);
    const sym = rt.providerSymbol;
    if (!sym || !this.sink) {
      this.emit(id);
      return;
    }
    this.busy.quote = true;
    try {
      const q = await this.client.quote(sym);
      if (this.active?.def.id !== id || rt.providerSymbol !== sym) return;
      let bid = q.bid;
      let ask = q.ask;
      let last = q.last;
      if (rt.inverted) {
        [bid, ask] = [ask ? 1 / ask : null, bid ? 1 / bid : null];
        last = last ? 1 / last : null;
      }
      // MT5 bars are Bid-based and spot/CFD symbols have no "last" trade price: display Bid.
      const price = last ?? bid;
      const change = price !== null && rt.prevDayClose !== null ? price - rt.prevDayClose : null;
      this.sink.quote(id, {
        last: price,
        bid,
        ask,
        high: rt.dayHigh,
        low: rt.dayLow,
        change,
        changePercent: change !== null && rt.prevDayClose ? (change / rt.prevDayClose) * 100 : null,
        volume: null, // MT5 tick volume is not traded volume
        timestamp: q.timeUtcMs,
        spreadPoints: rt.inverted ? null : q.spreadPoints,
      });
      rt.lastQuoteAt = q.timeUtcMs;
      if (q.timeUtcMs === null) rt.error = { code: 'TIMEZONE_UNRESOLVED', message: 'Broker server timezone unresolved: set TLUXE_MT5_SERVER_TIMEZONE on the bridge.' };
    } catch (e) {
      rt.error = errOf(e);
    } finally {
      this.busy.quote = false;
      this.emit(id);
    }
  }

  async pollCandles(): Promise<void> {
    const a = this.active;
    if (this.busy.candles || !a) return;
    const id = a.def.id;
    const rt = this.rt(id);
    if (!rt.providerSymbol) return;
    this.busy.candles = true;
    try {
      for (const tf of TIMEFRAMES) {
        if (rt.loaded.has(tf) && this.requested.get(id)?.has(tf)) await this.loadHistory(id, tf, 3, 'upsert');
      }
    } finally {
      this.busy.candles = false;
    }
  }

  /* ------------------------------ status/feed ------------------------------ */

  private marketOpen(def: InstrumentDefinition): boolean | null {
    if (def.tradingHours === '24/7') return true;
    if (def.tradingHours === null) return null;
    return getSessionState(def.tradingHours, this.now(), UPCOMING_WINDOW_MS).status === 'OPEN';
  }

  /** Compute and publish the truthful feed status for one instrument. */
  emit(id: InstrumentId): void {
    if (!this.sink || this.active?.def.id !== id) return;
    const def = this.active.def;
    const rt = this.rt(id);
    const st = this.state.getState();
    const loadedTfs = TIMEFRAMES.filter((tf) => rt.loaded.has(tf));
    const smallest = loadedTfs[0] ?? null;
    const counts = loadedTfs.map((tf) => rt.history[tf]?.count ?? 0);
    const fresh = freshnessCode(
      {
        now: this.now(),
        heartbeatAt: st.heartbeatAt,
        attempted: st.attempted,
        terminalState: st.terminal?.state ?? null,
        marketOpen: this.marketOpen(def),
        lastQuoteAt: rt.lastQuoteAt,
        lastCandleAt: smallest ? (rt.lastCandleAt[smallest] ?? null) : null,
        candleTfSec: smallest ? TIMEFRAME_SECONDS[smallest] : null,
        maxClosedBars: counts.length ? Math.max(...counts) : null,
      },
      this.cfg,
    );

    let code: FeedStatusCode = fresh;
    let message: string | null = null;
    const res = rt.resolution;
    if (rt.resyncing && (fresh === 'LIVE' || fresh === 'INSUFFICIENT_HISTORY')) {
      code = 'STALE';
      message = 'Reloading candles after an outage — not live until the history is complete.';
    } else if (st.error?.code === 'UNAUTHORIZED') {
      code = 'ERROR';
      message = 'The bridge rejected the access token.';
    } else if (fresh === 'MT5_BRIDGE_OFFLINE') {
      message = 'The TLUXE MT5 bridge is not reachable.';
    } else if (fresh === 'MT5_NOT_RUNNING') {
      message = st.error?.message ?? 'MetaTrader 5 terminal is not running.';
    } else if (fresh === 'ERROR' && st.terminal?.state === 'DISCONNECTED') {
      message = 'MT5 terminal is running but not connected to the broker server.';
    } else if (fresh !== 'MT5_CONNECTING' && !this.symbols) {
      code = 'MT5_CONNECTING';
    } else if (res?.status === 'not-found') {
      code = 'SYMBOL_NOT_FOUND';
      message = `${def.shortName} is not offered by this MT5 terminal.`;
    } else if (res?.status === 'ambiguous') {
      code = 'AMBIGUOUS_SYMBOL';
      message = `Several broker symbols match ${def.shortName}: ${res.candidates.join(', ')}. Set an override in Settings.`;
    } else if (rt.error) {
      code = 'ERROR';
      message = `${rt.error.code}: ${rt.error.message}`;
    }

    const detail: ProviderFeedDetail = {
      code,
      message,
      providerSymbol: rt.providerSymbol,
      candidates: res?.status === 'ambiguous' ? res.candidates : res?.status === 'resolved' ? res.alternatives : [],
      inverted: rt.inverted,
      lastQuoteAt: rt.lastQuoteAt,
      lastCandleAt: Math.max(0, ...Object.values(rt.lastCandleAt)) || null,
      lastClosedCandleAt: rt.lastClosedAt,
      bridgeHeartbeatAt: st.heartbeatAt,
      historyBars: Object.fromEntries(loadedTfs.map((tf) => [tf, rt.history[tf]!.count])),
      historyLimited: Object.fromEntries(loadedTfs.map((tf) => [tf, rt.history[tf]!.limited])),
      meta: rt.meta,
      realVolumeAvailable: rt.realVolume,
      quarantined: rt.quarantined,
      gaps: rt.gaps,
    };
    this.sink.feed(id, detail);
    this.sink.connection(id, connectionOf(code), code === 'ERROR' ? message : null);
  }
}
