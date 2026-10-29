/* ============================================================================
   GC HLR snapshot producer.

       Databento (authorized GC OHLCV)  ->  validate  ->  GCHLR engine
                                                              |
                                        /api/snapshot  <------+   -> hlr-gc.js

   RULES THIS FILE ENFORCES, in order of importance:

     1. NOTHING IS EVER INVENTED. No synthetic candle, price, depth row or
        signal. Every number here came from the feed or from the engine reading
        the feed. When anything is missing the snapshot says so and the
        dashboard withholds - `hlr-gc.js` already renders that state natively.

     2. MISSING CANDLES ARE NOT A HOLIDAY. The CME calendar decides whether a
        session should have traded; the candles decide whether it did. When the
        calendar says TRADING and the candles are absent, that is a DATA GAP and
        analysis is withheld - never quietly treated as a closed market.

     3. ONE CONTRACT PER SERIES. GCZ6 and GCG7 are different instruments with
        different histories. A series is built from one contract or not at all;
        splicing would manufacture a gap the engine would read as a real move.

     4. GC NEVER TOUCHES XAUUSD. Different engine global (GCHLR), different
        process, different endpoint. Nothing here can write XAUUSD state.

     5. READ ONLY. No order path, no e-mail path, no IBKR connection. Depth, if
        present, is display context and is never passed to the engine - the HLR
        strategy has no depth parameter.
   ========================================================================= */
'use strict';

const cal = require('./cme-calendar.cjs');

const TFS = ['1m', '5m', '15m', '1h', '4h'];
/** Databento's label for each engine timeframe. */
const DB_TF = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '1h': 'H1', '4h': 'H4' };
/** The engine's own minimum closed candles (hlr-engine.js CFG.minBars). */
const MIN_BARS = { '1m': 120, '5m': 120, '15m': 150, '1h': 120, '4h': 60 };
/** How old the newest bar may be, per timeframe, before the feed is called stale. */
const STALE_AFTER_MS = { '1m': 5 * 60e3, '5m': 15 * 60e3, '15m': 45 * 60e3,
                         '1h': 3 * 3600e3, '4h': 10 * 3600e3 };
const GC_DIGITS = 1;          // GC quotes to 0.1; XAUUSD is 2 (hlr-gc.js:197)
const GC_TICK = 0.1;

/** A bar is only usable if every field is a finite number and the OHLC is coherent. */
function barOk(b) {
  for (const k of ['time', 'open', 'high', 'low', 'close']) {
    if (typeof b[k] !== 'number' || !isFinite(b[k])) return false;
  }
  if (b.high < b.low) return false;
  if (b.open > b.high || b.open < b.low) return false;
  if (b.close > b.high || b.close < b.low) return false;
  // Unix SECONDS, not milliseconds. hlr-gc.js does b.t * 1000, so a ms value here
  // would silently place every candle ~55000 years from now.
  if (b.time > 1e11) return false;
  return true;
}

/** Databento bar -> the wire shape hlr-gc.js expects. Seconds in, seconds out. */
const toWire = (b) => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume });
/** Wire shape -> the engine's shape. The engine works in milliseconds. */
const toEngine = (r) => ({ t: r.t * 1000, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });

/**
 * Check one timeframe's payload. Returns {ok, bars, gate} - never throws, never fills.
 */
function validateSeries(tf, payload, now) {
  const gate = (why) => ({ ok: false, bars: [], gate: `${DB_TF[tf]}: ${why}` });
  if (!payload || !Array.isArray(payload.bars)) return gate('no candles returned');

  const clean = payload.bars.filter(barOk);
  if (clean.length !== payload.bars.length) {
    return gate(`${payload.bars.length - clean.length} malformed candle(s) - refusing the series`);
  }
  if (clean.length < MIN_BARS[tf]) {
    return gate(`${clean.length} candles, engine needs ${MIN_BARS[tf]}`);
  }
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].time <= clean[i - 1].time) return gate('candles are not strictly increasing in time');
  }
  const newest = clean[clean.length - 1];
  const age = now - newest.time * 1000;
  if (age > STALE_AFTER_MS[tf]) {
    return gate(`newest candle is ${Math.round(age / 60000)} min old`);
  }
  return { ok: true, bars: clean, gate: null };
}

/**
 * Was the last COMPLETED session actually delivered?
 * This is where rule 2 lives: the calendar says what should exist, the candles say what does.
 */
function checkLastSession(h1Bars, now) {
  let key = cal.sessionDayKey(now);
  for (let back = 1; back <= 10; back++) {
    const dayKey = key - back * cal.DAY;
    const st = cal.sessionStatus(dayKey);
    if (st.status === 'UNKNOWN') {
      return { ok: false, gate: `calendar unknown for ${st.date} (${st.reason})`, day: st.date };
    }
    if (st.status === 'WEEKEND' || st.status === 'HOLIDAY') continue;   // legitimately no session
    const b = cal.sessionBounds(dayKey);
    const n = h1Bars.filter((x) => x.time * 1000 >= b.start && x.time * 1000 < b.end).length;
    const need = cal.expectedMinBars(dayKey);
    if (n === 0) {
      return { ok: false, day: st.date,
               gate: `CME calendar says ${st.date} traded, but no candles were delivered - data gap, not a holiday` };
    }
    if (n < need) {
      return { ok: false, day: st.date,
               gate: `${st.date} delivered ${n} of at least ${need} expected H1 candles - incomplete session` };
    }
    return { ok: true, day: st.date, bars: n, earlyClose: st.earlyClose };
  }
  return { ok: false, gate: 'no completed session found in the last 10 days', day: null };
}

/**
 * Build the snapshot. `fetchTf(tf)` returns the Databento payload for one timeframe.
 * `depth` is optional IBKR context and is NEVER passed to the engine.
 */
async function buildSnapshot({ engine, fetchTf, depth = null, now = Date.now() }) {
  const gates = [];
  const snap = {
    contract: null,
    connected: false,
    market_status: 'NO_DATA',
    exchange_status: 'COMEX',
    analysis_enabled: false,
    analysis_blocker: null,
    gates,
    last_trade_price: null,
    previous_close: null,
    series: {},
    result: null,
    signals: [],
    stats: {},
    // provenance: every field's origin, so the UI (and a reader) can tell where a number came from
    provenance: {
      candles: 'databento:GLBX.MDP3 ohlcv',
      analysis: 'GCHLR (isolated GC engine)',
      depth: depth ? 'ibkr:COMEX PRICE_LEVEL (display only)' : 'none',
      calendar: `cme-calendar valid through ${cal.VALID_THROUGH}`,
    },
    digits: GC_DIGITS,
    tick: GC_TICK,
    generated_at: Math.floor(now / 1000),
  };

  // ---- fetch every timeframe ------------------------------------------------
  const payloads = {};
  for (const tf of TFS) {
    try {
      payloads[tf] = await fetchTf(tf);
    } catch (e) {
      payloads[tf] = null;
      gates.push(`${DB_TF[tf]}: fetch failed (${String(e.message || e).slice(0, 80)})`);
    }
  }

  // ---- one contract, or nothing (rule 3) ------------------------------------
  const contracts = [...new Set(TFS.map((tf) => payloads[tf] && payloads[tf].contract).filter(Boolean))];
  if (contracts.length === 0) {
    snap.analysis_blocker = 'No GC contract reported by the data source.';
    gates.push('contract: not reported');
    return snap;
  }
  if (contracts.length > 1) {
    snap.analysis_blocker = `Timeframes disagree on the contract (${contracts.join(', ')}) - refusing to mix instruments.`;
    gates.push(`contract: mixed (${contracts.join(', ')})`);
    snap.contract = { localSymbol: contracts[0] };
    return snap;
  }
  snap.contract = { localSymbol: contracts[0] };
  snap.connected = true;

  // ---- validate each series -------------------------------------------------
  const engineSeries = {};
  let allOk = true;
  for (const tf of TFS) {
    const v = validateSeries(tf, payloads[tf], now);
    if (!v.ok) { allOk = false; if (v.gate) gates.push(v.gate); continue; }
    snap.series[tf] = v.bars.map(toWire);
    engineSeries[tf] = v.bars.map((b) => toEngine(toWire(b)));
  }

  // ---- calendar vs candles (rule 2) ----------------------------------------
  const h1 = (payloads['1h'] && Array.isArray(payloads['1h'].bars)) ? payloads['1h'].bars.filter(barOk) : [];
  const sess = checkLastSession(h1, now);
  if (!sess.ok) { allOk = false; gates.push(sess.gate); }

  // ---- quote ---------------------------------------------------------------
  const m1 = snap.series['1m'];
  if (m1 && m1.length) {
    snap.last_trade_price = m1[m1.length - 1].c;
    snap.market_status = 'LIVE';
  }
  if (sess.ok && h1.length) {
    const b = cal.sessionBounds(cal.sessionDayKey(now) - cal.DAY);
    const prev = h1.filter((x) => x.time * 1000 >= b.start && x.time * 1000 < b.end);
    if (prev.length) snap.previous_close = prev[prev.length - 1].close;
  }

  // ---- analysis, only when everything above held ---------------------------
  if (!allOk) {
    snap.analysis_enabled = false;
    snap.market_status = snap.market_status === 'LIVE' ? 'DEGRADED' : 'NO_DATA';
    snap.analysis_blocker = 'Analysis withheld: ' + gates.join(' · ');
    return snap;
  }
  try {
    snap.result = engine.analyze({
      symbol: 'GC', digits: GC_DIGITS, series: engineSeries, asOf: now,
      health: { status: 'live' },
    });
    snap.analysis_enabled = !!(snap.result && snap.result.ok !== false);
    if (!snap.analysis_enabled) {
      snap.analysis_blocker = (snap.result && snap.result.reason) || 'Engine reported no result.';
    }
  } catch (e) {
    snap.analysis_enabled = false;
    snap.result = null;
    snap.analysis_blocker = 'Engine error - analysis withheld.';
    gates.push('engine: threw');
  }

  if (depth) snap.depth_context = depth;   // display only; never reaches the engine
  return snap;
}

module.exports = { buildSnapshot, validateSeries, checkLastSession, barOk, toWire, toEngine,
                   TFS, DB_TF, MIN_BARS, STALE_AFTER_MS, GC_DIGITS, GC_TICK };
