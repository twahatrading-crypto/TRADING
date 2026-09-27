import { DEFAULT_TIMEFRAME, QUOTE_STALE_AFTER_MS } from '../../../config/instrument';
import { getQuoteDisplayMode } from '../../market/normalize';
import type { InstrumentId } from '../../../types/instruments';
import type { Candle, MarketState, Timeframe } from '../../../types/market';
import { buildNewsContext, type NewsStateLike } from './newsContext';
import { AI_ENGINE_IDS, type AiCandle, type AiContext, type AiEngineId, type AiField, type AiProvenance } from './types';

/*
 * READ-ONLY context adapter for TLUXE AI.
 *
 * Reads the existing service stores (never calls a provider, never changes settings, never touches MT5 / Databento
 * connections) and produces a SMALL, provenance-tagged snapshot:
 *   - every field says LIVE / DELAYED / STALE / UNAVAILABLE and where it came from;
 *   - missing data is UNAVAILABLE with a reason — values are never estimated or filled in;
 *   - engine results are compacted to a fixed budget (arrays trimmed, depth limited) so the payload stays bounded;
 *   - anything that looks like a credential (keys named token / key / secret …, values shaped like API keys) is
 *     dropped before it leaves this module.
 */

export const AI_CONTEXT_LIMITS = { candles: 30, engineChars: 2_400, totalChars: 20_000, arrayItems: 6, depth: 4, stringChars: 160 } as const;

const SECRET_KEY = /(api[_-]?key|secret|token|password|passwd|authorization|bearer|credential|private[_-]?key|cookie|session[_-]?id|login)/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{8,}|db-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g;
const TIMEFRAMES: readonly Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

interface StoreLike<T> {
  getState(): T;
}

/** The subset of TLUXE services the adapter reads (all read-only). */
export interface AiContextSources {
  instruments: { store: StoreLike<{ activeId: InstrumentId }>; get?(id: InstrumentId): { id: string; name?: string; shortName?: string; kind?: string } | undefined };
  market: { store(id: InstrumentId): StoreLike<MarketState>; getCandles(id: InstrumentId, tf: Timeframe): readonly Candle[] };
  sr?: { store(id: InstrumentId): StoreLike<{ byTimeframe: Partial<Record<Timeframe, unknown>>; multi: unknown; computedAt: number | null }> };
  liquidity?: { store(id: InstrumentId): StoreLike<{ byTimeframe: Partial<Record<Timeframe, unknown>>; multi: unknown; computedAt: number | null }> };
  orderBlocks?: { store(id: InstrumentId): StoreLike<{ byTimeframe: Partial<Record<Timeframe, unknown>>; multi: unknown; computedAt: number | null }> };
  hlReversal?: { store(id: InstrumentId): StoreLike<{ snapshot: unknown; computedAt: number | null }> };
  highLow?: { store(id: InstrumentId): StoreLike<{ snapshot: unknown; computedAt: number | null }> };
  smc?: { store: StoreLike<{ instrumentId: InstrumentId; snapshot: unknown; computedAt: number | null }> };
  volumeProfile?: { store: StoreLike<{ instrumentId: InstrumentId; snapshot: unknown; computedAt: number | null }> };
  volumeFootprint?: { store: StoreLike<{ instrumentId: InstrumentId; supported: boolean; reason: string | null; provider: string | null; snapshot: unknown }> };
  newsAnalysis?: { store: StoreLike<NewsStateLike> };
}

const unavailable = <T>(source: string | null, reason: string): AiField<T> => ({ status: 'UNAVAILABLE', source, asOf: null, reason });

/**
 * Engines publish placeholder snapshots before they have processed any real candle (state NO_DATA,
 * knowledgeTime null). Those are NOT results: they are reported as UNAVAILABLE with the engine's own reason.
 */
export function engineNoDataReason(v: unknown): string | null {
  if (v === null || v === undefined) return 'No result yet.';
  if (typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const reason = typeof o.reason === 'string' ? o.reason : typeof o.unavailable === 'string' ? o.unavailable : null;
  if ('knowledgeTime' in o && o.knowledgeTime === null) return reason ?? 'Engine has not processed any real candle yet.';
  if (o.state === 'NO_DATA' || o.dataState === 'NO_DATA' || o.profileState === 'NO DATA') return reason ?? 'Engine has no data.';
  return null;
}

/** Strip secrets, round numbers, trim strings / arrays / depth. Pure; never throws. */
export function compactForAi(value: unknown, opts: { arrayItems?: number; depth?: number } = {}, depth = 0): unknown {
  const arrayItems = opts.arrayItems ?? AI_CONTEXT_LIMITS.arrayItems;
  const maxDepth = opts.depth ?? AI_CONTEXT_LIMITS.depth;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toPrecision(8)) : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '****').slice(0, AI_CONTEXT_LIMITS.stringChars);
  if (typeof value !== 'object') return null; // functions, symbols, bigint
  if (depth >= maxDepth) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const head = value.slice(0, arrayItems).map((v) => compactForAi(v, opts, depth + 1));
    return value.length > arrayItems ? [...head, `+${value.length - arrayItems} more`] : head;
  }
  if (value instanceof Map || value instanceof Set) return `[${value.size} items]`;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k) || typeof v === 'function') continue;
    if (++n > 30) {
      out['…'] = 'more fields omitted';
      break;
    }
    out[k] = compactForAi(v, opts, depth + 1);
  }
  return out;
}

/** Compact to a character budget, shrinking arrays / depth until it fits (never exceeds the budget). */
export function boundedForAi(value: unknown, maxChars: number = AI_CONTEXT_LIMITS.engineChars): unknown {
  for (const [arrayItems, depth] of [[6, 4], [3, 3], [2, 3], [1, 2]] as const) {
    const c = compactForAi(value, { arrayItems, depth });
    if (JSON.stringify(c).length <= maxChars) return c;
  }
  return '[result too large for the AI context budget]';
}

function marketProvenance(state: MarketState, now: number): { status: AiProvenance; reason?: string } {
  const mode = getQuoteDisplayMode(state, now, QUOTE_STALE_AFTER_MS);
  if (mode === 'live') return { status: 'LIVE' };
  if (mode === 'delayed') return { status: 'DELAYED' };
  if (mode === 'stale') return { status: 'STALE', reason: state.lastMessageAt === null ? 'No provider message received.' : `Last provider message ${Math.round((now - state.lastMessageAt) / 1000)} s ago.` };
  if (mode === 'connecting') return { status: 'UNAVAILABLE', reason: 'Provider connecting.' };
  return { status: 'UNAVAILABLE', reason: state.error ?? (state.provider ? 'Market data unavailable.' : 'No market data provider connected.') };
}

function readTimeframe(storage: Pick<Storage, 'getItem'> | null, id: InstrumentId): { value: Timeframe; source: string } {
  try {
    const raw = storage?.getItem(`tluxe.chart.tf.${id}`);
    const tf = raw ? (JSON.parse(raw) as unknown) : null;
    if (typeof tf === 'string' && (TIMEFRAMES as readonly string[]).includes(tf)) return { value: tf as Timeframe, source: 'dashboard chart selection' };
  } catch {
    /* storage blocked / corrupt */
  }
  return { value: DEFAULT_TIMEFRAME, source: 'dashboard chart default' };
}

const toAiCandle = (c: Candle): AiCandle => ({
  t: c.time,
  o: c.open,
  h: c.high,
  l: c.low,
  c: c.close,
  v: c.volume ?? c.realVolume ?? c.tickVolume ?? null,
  closed: c.isClosed ?? null,
});

/**
 * Build the bounded, provenance-tagged, read-only context for the active instrument.
 * `storage` is only READ (selected chart timeframe).
 */
export function buildAiContext(src: AiContextSources, now: number, storage: Pick<Storage, 'getItem'> | null = null): AiContext {
  const id = src.instruments.store.getState().activeId;
  const def = src.instruments.get?.(id);
  const m = src.market.store(id).getState();
  const tf = readTimeframe(storage, id);
  const prov = marketProvenance(m, now);
  const providerName = m.provider?.name ?? null;
  const source = providerName ?? null;
  const asOf = m.quote.timestamp ?? m.lastMessageAt;
  const has = prov.status !== 'UNAVAILABLE';

  const quoteHasValue = [m.quote.last, m.quote.bid, m.quote.ask].some((v) => v !== null && v !== undefined);
  const candles = src.market.getCandles(id, tf.value);
  const bars = candles.slice(-AI_CONTEXT_LIMITS.candles).map(toAiCandle);
  const lastBarMs = bars.length ? bars[bars.length - 1]!.t * 1000 : null;

  // Engine results inherit the input feed's freshness: a result computed from stale data is STALE.
  const engineStatus: AiProvenance = prov.status === 'UNAVAILABLE' ? 'STALE' : prov.status;
  const engine = (name: string, value: unknown, computedAt: number | null, missing: string): AiField<unknown> =>
    value === null || value === undefined
      ? unavailable(name, missing)
      : engineNoDataReason(value) !== null
        ? unavailable(name, `${engineNoDataReason(value)} (${missing})`)
        : { status: engineStatus, source: name, asOf: computedAt, value: boundedForAi(value), ...(engineStatus === 'STALE' ? { reason: 'Computed from market data that is not current.' } : {}) };
  const perTf = (name: string, s: { byTimeframe: Partial<Record<Timeframe, unknown>>; multi: unknown; computedAt: number | null } | undefined) =>
    !s ? unavailable(name, 'Engine not available.') : engine(name, s.byTimeframe[tf.value] ?? s.multi, s.computedAt, `No ${name} result for ${id} ${tf.value} yet (needs real candles).`);
  const single = (name: string, s: { snapshot: unknown; computedAt: number | null } | undefined) =>
    !s ? unavailable(name, 'Engine not available.') : engine(name, s.snapshot, s.computedAt, `No ${name} result for ${id} yet (needs real candles).`);
  const active = <T extends { instrumentId: InstrumentId }>(s: T | undefined): T | undefined => (s && s.instrumentId === id ? s : undefined);

  const fp = active(src.volumeFootprint?.store.getState());
  const news = src.newsAnalysis?.store.getState();
  const newsCtx = buildNewsContext(news, id);
  const newsFeeds = news ? Object.values(news.feeds) : [];
  // Only a real (non-test) connected feed counts; test providers are never used as market context.
  const newsLive = newsFeeds.some((f) => !f.test && (f.status === 'LIVE' || f.status === 'CONNECTED' || f.status === 'DELAYED'));

  const engines: Record<AiEngineId, AiField<unknown>> = {
    sr: perTf('TLUXE S&R engine', src.sr?.store(id).getState()),
    liquidity: perTf('TLUXE Liquidity engine', src.liquidity?.store(id).getState()),
    orderBlocks: perTf('TLUXE Order Block engine', src.orderBlocks?.store(id).getState()),
    hlReversal: single('TLUXE High/Low Reversal engine', src.hlReversal?.store(id).getState()),
    highLow: single('TLUXE High/Low Engine', src.highLow?.store(id).getState()),
    smc: single('TLUXE SMC engine', active(src.smc?.store.getState())),
    volumeProfile: single('TLUXE Volume Profile engine', active(src.volumeProfile?.store.getState())),
    volumeFootprint: !fp
      ? unavailable('TLUXE Volume Footprint engine', 'Engine not available for this instrument.')
      : !fp.supported || !fp.snapshot || engineNoDataReason(fp.snapshot) !== null
        ? unavailable(fp.provider ?? 'TLUXE Volume Footprint engine', fp.reason ?? 'No exchange trade data (time & sales) for this instrument.')
        : { status: engineStatus, source: fp.provider ?? 'TLUXE Volume Footprint engine', asOf: null, value: boundedForAi(fp.snapshot) },
    // The full, bounded news picture is `ctx.news`; this entry only reports the News Analysis engine's state.
    newsAnalysis: !news
      ? unavailable('TLUXE News Analysis', 'Engine not available.')
      : !newsLive
        ? unavailable('TLUXE News Analysis', 'No news / calendar provider connected.')
        : { status: newsCtx.status, source: 'TLUXE News Analysis', asOf: news.now, value: { see: 'news', events: news.snapshot.events.length } },
  };
  for (const k of AI_ENGINE_IDS) if (!engines[k]) engines[k] = unavailable(k, 'Engine not available.');

  const ctx: AiContext = {
    schema: 'tluxe.ai.context.v1',
    generatedAt: now,
    readOnly: true,
    instrument: { id, name: def?.name ?? m.instrument.name ?? id, kind: def?.kind ?? 'unknown' },
    timeframe: tf,
    provider: providerName
      ? { status: prov.status, source, asOf: m.lastMessageAt, value: { name: providerName, connection: m.connection, feedCode: m.feed?.code ?? null, providerSymbol: m.feed?.providerSymbol ?? null }, ...(prov.reason ? { reason: prov.reason } : {}) }
      : unavailable(null, 'No market data provider connected.'),
    freshness: has || m.lastMessageAt !== null ? { status: prov.status, source, asOf: m.lastMessageAt, value: { lastMessageAgeMs: m.lastMessageAt === null ? null : now - m.lastMessageAt }, ...(prov.reason ? { reason: prov.reason } : {}) } : unavailable(source, prov.reason ?? 'No market data.'),
    quote:
      quoteHasValue && prov.status !== 'UNAVAILABLE'
        ? { status: prov.status, source, asOf, value: { last: m.quote.last, bid: m.quote.bid, ask: m.quote.ask, high: m.quote.high, low: m.quote.low, change: m.quote.change, timestamp: m.quote.timestamp }, ...(prov.reason ? { reason: prov.reason } : {}) }
        : unavailable(source, prov.reason ?? 'No quote available.'),
    candles: bars.length
      ? { status: prov.status === 'UNAVAILABLE' ? 'STALE' : prov.status, source: candles[candles.length - 1]?.source ?? source, asOf: lastBarMs, value: { timeframe: tf.value, count: bars.length, bars }, ...(prov.status === 'UNAVAILABLE' ? { reason: 'Feed not connected - last known candles.' } : {}) }
      : unavailable(source, `No ${tf.value} candles for ${id}.`),
    engines,
    news: newsCtx,
  };
  // Hard ceiling: drop engine values (keeping their status) if the whole snapshot is still too large.
  if (JSON.stringify(ctx).length > AI_CONTEXT_LIMITS.totalChars) {
    for (const k of AI_ENGINE_IDS) {
      const e = ctx.engines[k];
      if (e.value !== undefined) ctx.engines[k] = { ...e, value: '[omitted: context budget]' };
      if (JSON.stringify(ctx).length <= AI_CONTEXT_LIMITS.totalChars) break;
    }
  }
  // Then trim the news lists (oldest / least relevant last) — the AI backend rejects contexts above 24 KB.
  const nv = ctx.news.value;
  while (nv && JSON.stringify(ctx).length > AI_CONTEXT_LIMITS.totalChars) {
    const list = [nv.headlines, nv.today, nv.recentReleases, nv.nextHighImpact].find((l) => l.length > 1);
    if (!list) break;
    list.pop();
  }
  return ctx;
}
