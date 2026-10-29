/* ============================================================================
   HIGH / LOW REVERSAL — engine.

   One question, asked with a fixed multi-timeframe sequence:

     BUY   important LOW  -> SSL sweep -> rejection / reclaim
                          -> bullish M5 CHOCH/BOS on a CLOSED candle
                          -> M1 pullback -> BUY
     SELL  important HIGH -> BSL sweep -> rejection / reclaim
                          -> bearish M5 CHOCH/BOS on a CLOSED candle
                          -> M1 pullback -> SELL

   WHAT THIS FILE IS NOT
   ---------------------
   It is not "price is at a high, therefore sell". A level on its own is stage
   one of five. Every later stage is attempted only from the bar the previous
   stage completed on, so no stage can be skipped and no level, however strong,
   can produce a direction by itself.

   NO LOOK-AHEAD. Candles enter through VPR.closedAt() and nothing else, so a
   bar that has not finished cannot be read. Every threshold that judges a past
   stage is measured against the ATR AS IT STOOD AT THAT BAR (VPR.atrSeries),
   never today's — otherwise a confirmed stage could silently un-confirm itself
   as new candles arrive.

   MEASUREMENT IS SHARED, NOT DUPLICATED. Swings, ATR, liquidity clusters,
   session windows, FVGs and order blocks all come from the existing detectors
   (VPR, AUTODRAW, ZONES). This file sequences them; it re-implements none.
   ========================================================================== */
(function (global) {

  /* Roles, not opinions: each interval answers exactly one question. */
  const TF = Object.freeze({
    direction: '4h',    // which way the market is actually structured
    zones:     '1h',    // which highs and lows are worth caring about
    liquidity: '15m',   // did price take one of them
    confirm:   '5m',    // did structure actually turn, on a closed candle
    entry:     '1m'     // where the pullback offers a defined risk
  });
  const REQUIRED_TFS = ['1m', '5m', '15m', '1h', '4h'];

  /* ------------------------------------------------------------- thresholds
     Stated constants, not fitted parameters. Exported so the UI can show the
     exact number a measurement was judged against. */
  const CFG = Object.freeze({
    atrLen:          14,
    swingK:           2,     // bars each side required to confirm a pivot

    dirSwings:      200,     // H4 bars scanned for direction structure
    zoneSwings:     300,     // H1 bars scanned for major swings
    levelTolAtr:   0.25,     // "price reached the level", in M15 ATR

    nearAtr:       2.00,     // level close enough to watch, in M15 ATR
    sweepWindow:     48,     // M15 bars back scanned for a sweep
    sweepMinAtr:   0.10,     // penetration beyond the level to count as a sweep
    reclaimWindow:    4,     // M15 bars allowed to close back through the level
    rejectWick:    0.45,     // wick / range on the sweep candle

    confirmWindow:   72,     // M5 bars after the sweep allowed to confirm
    breakMarginAtr:0.05,     // close must clear the broken swing by this
    dispBodyAtr:   1.00,     // displacement body, in M5 ATR
    dispBodyPct:   0.50,     // displacement body / range

    entryWindow:    180,     // M1 bars after confirmation allowed to pull back
    pullbackMin:  0.500,     // entry band, fib of the impulse leg
    pullbackMax:  0.786,
    stopBufferAtr: 0.15,     // beyond the swept extreme
    minRR:          1.5,     // reported, never used to fabricate a target

    expiryBars:      48,     // M15 bars after the sweep before the setup is stale
    minBars: Object.freeze({ '1m': 120, '5m': 120, '15m': 150, '1h': 120, '4h': 60 })
  });

  /* ------------------------------------------------------- mandatory sequence
     The five conditions a direction must satisfy, in order. The score below
     cannot add to this list and cannot remove from it. */
  const STAGES = [
    { n: 1, key: 'LEVEL',    buy: 'Important Low',     sell: 'Important High' },
    { n: 2, key: 'SWEEP',    buy: 'SSL Swept',         sell: 'BSL Swept' },
    { n: 3, key: 'STRUCT',   buy: 'Bullish CHOCH/BOS', sell: 'Bearish CHOCH/BOS' },
    { n: 4, key: 'PULLBACK', buy: 'Pullback (M1)',     sell: 'Pullback (M1)' },
    { n: 5, key: 'ENTRY',    buy: 'BUY Confirmed',     sell: 'SELL Confirmed' }
  ];
  const STAGE_N = {};
  STAGES.forEach(s => { STAGE_N[s.key] = s.n; });

  /* Rejection / reclaim is checked inside SWEEP: a penetration that never
     comes back is a breakout, not a sweep. It is reported separately in the
     M15 card but it is not a pipeline box of its own. */

  const SIGNALS = {
    NO_DATA:        'WAITING FOR DATA',
    NO_SETUP:       'NO SETUP',
    WATCHING_BUY:   'WATCHING BUY',
    WATCHING_SELL:  'WATCHING SELL',
    WAITING:        'WAITING',
    BUY_CONFIRMED:  'BUY CONFIRMED',
    SELL_CONFIRMED: 'SELL CONFIRMED',
    INVALIDATED:    'INVALIDATED'
  };

  const BLOCKERS = {
    NO_DATA:           'WAITING FOR DATA',
    NO_LEVEL:          'NO IMPORTANT LEVEL',
    NOT_AT_LEVEL:      'PRICE NOT AT LEVEL',
    TOO_FAR:           'TOO FAR FROM LEVEL',
    WAITING_SWEEP:     'WAITING SWEEP',
    WAITING_RECLAIM:   'WAITING REJECTION',
    WAITING_STRUCTURE: 'WAITING M5 CHOCH/BOS',
    WAITING_PULLBACK:  'WAITING M1 PULLBACK',
    NO_TARGET:         'NO VALID TARGET',
    EXPIRED:           'SETUP EXPIRED',
    LEVEL_BROKEN:      'LEVEL BROKEN, NOT SWEPT',
    STRUCTURE_FAILED:  'STRUCTURE FAILED',
    DATA_STALE:        'DATA STALE',
    DISCONNECTED:      'DISCONNECTED',
    NONE:              'NONE'
  };

  /* ---------------------------------------------------------- level ratings */
  const RATING_WEIGHTS = Object.freeze({
    kind:      0.30,   // what the level is (a previous day high outranks an Asia high)
    touches:   0.22,   // how many confirmed pivots formed it
    reaction:  0.20,   // how hard price left it, in ATR
    freshness: 0.16,   // how recently it formed
    untouched: 0.12    // has it already been taken
  });
  const KIND_WEIGHT = Object.freeze({
    pdh: 0.95, pdl: 0.95, major: 0.90, asia: 0.60, swing: 0.55
  });
  const RATING_BANDS = Object.freeze({ strong: 0.66, medium: 0.40 });

  /* ------------------------------------------------------------- score model
     Informational only. It describes how good a setup looks; it can never
     create one, and 100/100 with a missing mandatory stage is still not an
     entry. Weights sum to 100 so the card's rows add up on screen. */
  const SCORE_WEIGHTS = Object.freeze([
    { key: 'htf',    label: 'HTF Alignment',            max: 20 },
    { key: 'level',  label: 'Level Importance',         max: 20 },
    { key: 'sweep',  label: 'Sweep Quality',            max: 15 },
    { key: 'reject', label: 'Rejection / Displacement', max: 15 },
    { key: 'm5',     label: 'M5 Structure',             max: 15 },
    { key: 'm1',     label: 'M1 Entry Quality',         max: 10 },
    { key: 'conf',   label: 'FVG / OB Confluence',      max: 5  }
  ]);

  /* ==================================================================== util */

  const tfMs = tf => (MKT.TFS[tf] || {}).ms || 60e3;
  const last = a => (a && a.length ? a[a.length - 1] : null);
  const clamp01 = v => (isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
  const DAY = 86400000;

  const ratingOf = s => s >= RATING_BANDS.strong ? 'Strong'
                      : s >= RATING_BANDS.medium ? 'Medium' : 'Weak';

  /** Index of the last bar at or before time t. -1 when there is none. */
  function indexAtTime(bars, t) {
    let lo = 0, hi = bars.length - 1, out = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (bars[m].t <= t) { out = m; lo = m + 1; } else hi = m - 1;
    }
    return out;
  }

  /** Index of the first bar at or after time t. -1 when there is none. */
  function indexFromTime(bars, t) {
    let lo = 0, hi = bars.length - 1, out = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (bars[m].t >= t) { out = m; hi = m - 1; } else lo = m + 1;
    }
    return out;
  }

  /* ================================================================ H4 DIRECTION
     The swing sequence itself, read by the shared detector. Nothing about the
     direction card is measured here that VPR does not already measure. */

  function direction(h4) {
    const base = { label: 'WAITING FOR DATA', dir: 0, structure: null,
                   lastSwingHigh: null, lastSwingLow: null, strength: null,
                   bias: 'Not enough closed H4 candles yet.' };
    if (!h4 || h4.length < CFG.minBars['4h']) {
      base.reason = 'need ' + CFG.minBars['4h'] + ' closed H4 candles, have ' +
                    (h4 ? h4.length : 0);
      return base;
    }

    const sb = VPR.structureBias(h4);
    const from = Math.max(0, h4.length - CFG.dirSwings);
    const pv = VPR.swings(h4, CFG.swingK, from);
    const hi = last(pv.highs), lo = last(pv.lows);

    /* Strength is how consistent the recent swing sequence is with the label,
       not a momentum oscillator: of the last four swing steps, how many moved
       the way the label claims. Reported as 0..1 and as a count, so the bar on
       screen is a fact the reader can recount off the chart. */
    const steps = [];
    const seq = (arr, wantUp) => {
      for (let i = Math.max(1, arr.length - 4); i < arr.length; i++) {
        steps.push(wantUp ? arr[i].price > arr[i - 1].price
                          : arr[i].price < arr[i - 1].price);
      }
    };
    let strength = null;
    if (sb.dir !== 0) {
      seq(pv.highs, sb.dir > 0);
      seq(pv.lows,  sb.dir > 0);
      strength = steps.length
        ? { value: steps.filter(Boolean).length / steps.length,
            agree: steps.filter(Boolean).length, total: steps.length }
        : null;
    }

    const label = sb.dir > 0 ? 'BULLISH' : sb.dir < 0 ? 'BEARISH' : 'NEUTRAL';
    const structure = sb.dir > 0 ? 'Higher Highs + Higher Lows'
                    : sb.dir < 0 ? 'Lower Highs + Lower Lows'
                    : sb.label === 'RANGING' ? 'Mixed swing sequence'
                    : sb.reason;

    return {
      label: label, dir: sb.dir, raw: sb.label, reason: sb.reason,
      structure: structure,
      lastSwingHigh: hi ? { price: hi.price, t: hi.t } : null,
      lastSwingLow:  lo ? { price: lo.price, t: lo.t } : null,
      strength: strength,
      bias: sb.dir > 0 ? 'Main bias: look for BUY setups only.'
          : sb.dir < 0 ? 'Main bias: look for SELL setups only.'
          : 'No H4 direction. Both sides are counter-trend until structure picks a side.'
    };
  }

  /* =================================================================== H1 BIAS */

  function h1Bias(h1, levels) {
    if (!h1 || h1.length < CFG.minBars['1h']) {
      return { label: 'WAITING FOR DATA', dir: 0, note: 'Not enough closed H1 candles.' };
    }
    const sb = VPR.structureBias(h1);
    const label = sb.dir > 0 ? 'BULLISH' : sb.dir < 0 ? 'BEARISH' : 'NEUTRAL';
    /* The sub-line names the nearest structural level price is working
       against, because "bullish" alone says nothing about where it is. */
    let note = sb.reason;
    if (levels && levels.length) {
      const price = last(h1).c;
      const above = levels.filter(l => l.price > price).sort((a, b) => a.price - b.price)[0];
      const below = levels.filter(l => l.price < price).sort((a, b) => b.price - a.price)[0];
      if (sb.dir > 0 && below) note = 'Above key level ' + below.label;
      else if (sb.dir < 0 && above) note = 'Below key level ' + above.label;
      else if (above && below) note = 'Between ' + below.label + ' and ' + above.label;
    }
    return { label: label, dir: sb.dir, reason: sb.reason, note: note };
  }

  /* ================================================================== LEVELS */

  /**
   * The high and low of the most recent run of candles inside a session's own
   * window. Membership is decided by VPR.inWindow, so DST and the weekend rule
   * are handled by the existing implementation rather than a second one here.
   */
  function sessionRange(bars, def, barMs) {
    if (!bars || !bars.length) return null;
    barMs = barMs || 0;
    let i = bars.length - 1;
    while (i >= 0 && !VPR.inWindow(def, bars[i].t)) i--;
    if (i < 0) return null;
    const endIdx = i;
    let high = -Infinity, low = Infinity, from = null, n = 0;
    let highAt = null, lowAt = null;
    for (; i >= 0 && VPR.inWindow(def, bars[i].t); i--) {
      /* `>=` while walking backwards keeps the EARLIEST bar that reached the
         extreme - the moment it first became knowable, not the last time it
         was matched. */
      if (bars[i].h >= high) { high = bars[i].h; highAt = bars[i].t; }
      if (bars[i].l <= low)  { low = bars[i].l;  lowAt = bars[i].t; }
      from = bars[i].t; n++;
    }
    return { high: high, low: low, from: from, to: bars[endIdx].t, bars: n,
             live: VPR.inWindow(def, last(bars).t), endIndex: endIdx,
             highAt: highAt, lowAt: lowAt,
             /* knowable only once the candle that set the extreme has closed */
             highValidFrom: highAt == null ? null : highAt + barMs,
             lowValidFrom: lowAt == null ? null : lowAt + barMs };
  }

  /* ======================================================== GC SESSION DAY ====
     THE ONE APPROVED DIFFERENCE FROM THE ORIGINAL XAUUSD ENGINE.

     The original buckets by UTC midnight, which is right for spot XAUUSD. COMEX
     gold does not trade a UTC day: the GC session runs 18:00 ET (D-1) -> 17:00
     ET (D), with 17:00-18:00 ET closed. Bucketing GC by UTC midnight cuts a
     session in half, so PDH/PDL describe something no futures tool would
     recognise - and KIND_WEIGHT rates pdh/pdl at 0.95, the highest of any level
     type, so the error lands on the most heavily weighted level in the model.

     Measured on real GCZ6 H1 data, the two definitions disagreed on 3 of 8
     recent days, once by $21.10 on the high.

     DST is handled by Intl in America/New_York - never a fixed UTC offset,
     which would be wrong for half the year.

     HOLIDAYS, EARLY CLOSES AND MISSING SESSIONS need no calendar file, and
     deliberately so. The loop walks back until it finds a session that ACTUALLY
     HAS CANDLES, so a holiday is skipped because it produced no bars, and an
     early close simply yields a shorter session. A hard-coded holiday table
     would be a guess that silently rots; the candles are the authority. Too few
     bars still returns null, so the caller withholds rather than guesses. */
  const NY_TZ = 'America/New_York';
  let _nyFmt = null;
  function nyHourDate(ms) {
    if (!_nyFmt) {
      _nyFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: NY_TZ, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
      });
    }
    const p = {};
    for (const part of _nyFmt.formatToParts(new Date(ms))) {
      if (part.type !== 'literal') p[part.type] = part.value;
    }
    const h = p.hour === '24' ? 0 : Number(p.hour);   /* some engines report midnight as 24 */
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: h };
  }

  /** The CME session day a timestamp belongs to, as a UTC-midnight key. */
  function gcSessionDay(ms) {
    const p = nyHourDate(ms);
    let key = Date.UTC(p.y, p.m - 1, p.d);
    /* 17:00 ET closes a session and 18:00 ET opens the next, so anything at or
       after 17:00 ET belongs to the FOLLOWING session day. */
    if (p.h >= 17) key += DAY;
    return key;
  }

  /** Real start/end instants of a GC session day, DST included. */
  function gcSessionBounds(dayKey) {
    const HOUR = 3600000;
    let start = null, end = null;
    /* Scan the 72 hours around the key and keep the instants whose session day
       matches. Cheap, and correct across both DST transitions with no offset
       arithmetic to get wrong. */
    for (let t = dayKey - 36 * HOUR; t <= dayKey + 36 * HOUR; t += HOUR) {
      if (gcSessionDay(t) === dayKey) { if (start === null) start = t; end = t + HOUR; }
    }
    return { start: start, end: end };
  }

  /** High and low of the most recent COMPLETED GC SESSION day, from H1 candles. */
  function previousDay(h1, asOf) {
    if (!h1 || !h1.length) return null;
    const today = gcSessionDay(asOf);
    /* Walk back over SESSION days until one actually has candles: a weekend or
       an exchange holiday has none, and the previous session is then the last
       day that actually traded. */
    for (let back = 1; back <= 7; back++) {
      const _b = gcSessionBounds(today - back * DAY);
      if (_b.start === null) continue;
      const d0 = _b.start, d1 = _b.end;
      let high = -Infinity, low = Infinity, n = 0, endIdx = -1;
      for (let i = 0; i < h1.length; i++) {
        if (h1[i].t < d0) continue;
        if (h1[i].t >= d1) break;
        high = Math.max(high, h1[i].h); low = Math.min(low, h1[i].l);
        n++; endIdx = i;
      }
      /* The previous day's extremes are only final - and only knowable - once
         that day has ended. That instant is d1, never the bar that set them. */
        /* The caller uses `day + DAY` as the level's formedAt, which in the
           original equals the end of that UTC day. A GC session is 23 hours,
           not 24, so returning its START here would put formedAt an hour after
           the session actually closed and shift the freshness component of the
           rating. Anchor on the end instead, so `day + DAY === d1` exactly as
           the original intended. */
        if (n >= 4) return { high: high, low: low, day: d1 - DAY, bars: n, endIndex: endIdx,
                             validFrom: d1, sessionStart: d0, sessionEnd: d1 };
    }
    return null;
  }

  /* ====================================================== CAUSALITY: validFrom
     A level does not exist until the engine could have known it. Everything a
     level can take part in - touch, sweep, reclaim, rejection, break,
     invalidation, CHOCH/BOS attribution, confirmation - is gated on

         eventTime >= level.validFrom

     measured on the candle's OPEN, so a candle that was already running when
     the level appeared cannot be credited with reacting to it either.

     This is not a refinement. Without it a 16:00 candle can be recorded as
     sweeping an Asia Low that does not begin to exist until 00:00 the next
     morning, and a setup built on that sweep is built on information nobody
     had at the time. */

  /** First bar that STARTS at or after `t`. -1 when there is none. */
  function firstBarFrom(bars, t) {
    if (t == null) return 0;
    return indexFromTime(bars, t);
  }

  /**
   * When a swing pivot becomes a CONFIRMED swing: VPR.swings needs k bars on
   * BOTH sides, so a pivot at bar i is not a pivot to anyone until bar i+k has
   * closed. Using the pivot candle's own timestamp would be exactly the hidden
   * look-ahead this whole section exists to stop.
   */
  function swingValidFrom(bars, pivotTime, ms) {
    const k = (VPR.CFG && VPR.CFG.swingK) || CFG.swingK;
    const i = indexAtTime(bars, pivotTime);
    if (i < 0) return null;
    const j = i + k;
    if (j > bars.length - 1) return null;      // not confirmed yet: unknowable
    return bars[j].t + ms;
  }

  /**
   * Has a level already been taken, judged only on candles that opened at or
   * after the level became valid. A wick through is SWEPT; a close through is
   * CONSUMED — a level price has closed beyond is no longer a level, and a
   * setup must not be built on it.
   */
  function levelState(bars, side, price, validFrom, tol) {
    let state = 'ACTIVE', at = null, maxPen = 0;
    const from = firstBarFrom(bars, validFrom);
    if (from < 0) return { state: state, at: at, penetration: 0 };
    for (let i = Math.max(0, from); i < bars.length; i++) {
      const pierced = side === 'high' ? bars[i].h > price + tol : bars[i].l < price - tol;
      if (!pierced) continue;
      maxPen = Math.max(maxPen, side === 'high' ? bars[i].h - price : price - bars[i].l);
      const closedBeyond = side === 'high' ? bars[i].c > price + tol
                                           : bars[i].c < price - tol;
      if (closedBeyond) { state = 'CONSUMED'; at = bars[i].t; break; }
      if (state === 'ACTIVE') { state = 'SWEPT'; at = bars[i].t; }
    }
    return { state: state, at: at, penetration: maxPen };
  }

  /** How hard price left the level after it became valid, in ATR at that time. */
  function reactionAtr(bars, side, price, validFrom, atrSeries) {
    const from = firstBarFrom(bars, validFrom);
    if (from < 0) return 0;
    const a = atrSeries[Math.min(from, atrSeries.length - 1)] || 0;
    if (!a) return 0;
    let best = 0;
    const stop = Math.min(bars.length - 1, from + 24);
    for (let i = from + 1; i <= stop; i++) {
      best = Math.max(best, side === 'high' ? price - bars[i].l : bars[i].h - price);
    }
    return best / a;
  }

  function rateLevel(parts) {
    const s = RATING_WEIGHTS.kind      * clamp01(parts.kind)
            + RATING_WEIGHTS.touches   * clamp01(parts.touches)
            + RATING_WEIGHTS.reaction  * clamp01(parts.reaction)
            + RATING_WEIGHTS.freshness * clamp01(parts.freshness)
            + RATING_WEIGHTS.untouched * clamp01(parts.untouched);
    return { score: s, rating: ratingOf(s), parts: parts };
  }

  /**
   * Every high and low the strategy is allowed to care about, each with a
   * price, a state and a Weak / Medium / Strong rating built from stated
   * components. The strategy only ever looks at levels from this set.
   */
  function levelSet(h1, m15, asOf) {
    const out = [];
    if (!h1 || h1.length < 40) return out;

    const A1 = VPR.atrSeries(h1, CFG.atrLen);
    const a1 = A1[A1.length - 1] || 0;
    const tol = Math.max(a1 * 0.15, last(h1).c * 0.00015);
    const now = last(h1).t;
    const span = Math.max(1, now - h1[Math.max(0, h1.length - CFG.zoneSwings)].t);

    const push = (key, label, kind, side, price, formedAt, touches, validFrom) => {
      if (price == null || !isFinite(price)) return;
      /* Not knowable yet (an unconfirmed swing, a session extreme whose candle
         has not closed) - so it is not a level, and it is not published. */
      if (validFrom == null || validFrom > asOf) return;
      const st = levelState(h1, side, price, validFrom, tol);
      const rated = rateLevel({
        kind:      KIND_WEIGHT[kind] == null ? 0.5 : KIND_WEIGHT[kind],
        touches:   Math.min(1, (touches - 1) / 3),
        reaction:  reactionAtr(h1, side, price, validFrom, A1) / 3,
        freshness: formedAt == null ? 0.5 : clamp01(1 - (now - formedAt) / span),
        untouched: st.state === 'ACTIVE' ? 1 : st.state === 'SWEPT' ? 0.5 : 0
      });
      out.push({
        key: key, label: label, kind: kind, side: side, price: price,
        formedAt: formedAt, validFrom: validFrom, touches: touches,
        state: st.state, sweptAt: st.at, penetration: st.penetration,
        rating: rated.rating, ratingScore: rated.score, parts: rated.parts,
        tol: tol
      });
    };

    /* ---- previous day ---- */
    const pd = previousDay(h1, asOf);
    if (pd) {
      /* valid from the moment that day closed, never from the candle inside it
         that happened to set the extreme */
      push('pdh', 'Prev Day High', 'pdh', 'high', pd.high, pd.day + DAY, 1, pd.validFrom);
      push('pdl', 'Prev Day Low',  'pdl', 'low',  pd.low,  pd.day + DAY, 1, pd.validFrom);
    }

    /* ---- Asia session ---- */
    const asiaDef = VPR.SESSION_DEFS.find(d => d.key === 'asian');
    const asiaBars = (m15 && m15.length) ? m15 : h1;
    const asiaMs = (m15 && m15.length) ? tfMs('15m') : tfMs('1h');
    const asia = sessionRange(asiaBars, asiaDef, asiaMs);
    if (asia) {
      /* each side is valid from the close of the candle that set IT - the high
         and the low of one session become knowable at different times */
      push('asiaHigh', 'Asia High', 'asia', 'high', asia.high, asia.highAt, 1,
           asia.highValidFrom);
      push('asiaLow',  'Asia Low',  'asia', 'low',  asia.low,  asia.lowAt, 1,
           asia.lowValidFrom);
    }

    /* ---- major swings, from the shared liquidity clusterer ---- */
    const price = last(h1).c;
    const liq = VPR.liquidityLevels(h1);
    const majors = { high: null, low: null };
    liq.all.forEach(l => {
      const side = l.side === 'buy' ? 'high' : 'low';
      const cand = { price: l.price, pivots: l.pivots, lastTime: l.lastTime, state: l.state };
      const cur = majors[side];
      /* "Major" = the cluster with the most confirmed pivots; ties break to the
         one nearest current price, which is the one that matters now. */
      if (!cur || cand.pivots > cur.pivots ||
          (cand.pivots === cur.pivots &&
           Math.abs(cand.price - price) < Math.abs(cur.price - price))) {
        majors[side] = cand;
      }
    });
    /* A cluster's averaged price does not exist until its LAST member pivot is
       confirmed, so that is its validFrom. Clustering therefore cannot smuggle
       in evidence from before the cluster existed. */
    if (majors.high) push('majorHigh', 'Major Swing High', 'major', 'high',
                          majors.high.price, majors.high.lastTime, majors.high.pivots,
                          swingValidFrom(h1, majors.high.lastTime, tfMs('1h')));
    if (majors.low)  push('majorLow',  'Major Swing Low',  'major', 'low',
                          majors.low.price, majors.low.lastTime, majors.low.pivots,
                          swingValidFrom(h1, majors.low.lastTime, tfMs('1h')));

    /* ---- everything else the clusterer found, for "View All Levels" ---- */
    liq.all.forEach((l, i) => {
      const side = l.side === 'buy' ? 'high' : 'low';
      if (majors[side] && Math.abs(l.price - majors[side].price) <= tol) return;
      push('swing:' + side + ':' + i,
           (l.equal ? (side === 'high' ? 'Equal Highs' : 'Equal Lows')
                    : (side === 'high' ? 'Swing High' : 'Swing Low')),
           'swing', side, l.price, l.lastTime, l.pivots,
           swingValidFrom(h1, l.lastTime, tfMs('1h')));
    });

    return out;
  }

  /** The six headline levels the H1 card shows, in the card's own order. */
  const HEADLINE = ['pdh', 'pdl', 'asiaHigh', 'asiaLow', 'majorHigh', 'majorLow'];
  const headlineLevels = set => HEADLINE
    .map(k => set.find(l => l.key === k))
    .filter(Boolean);

  /* ============================================================ THE SEQUENCE */

  /** The high and low actually traded in the sweep scan window. */
  function m15Window(m15) {
    let hi = -Infinity, lo = Infinity;
    for (let i = Math.max(0, m15.length - CFG.sweepWindow); i < m15.length; i++) {
      if (m15[i].h > hi) hi = m15[i].h;
      if (m15[i].l < lo) lo = m15[i].l;
    }
    return { high: hi, low: lo };
  }

  /** How far a walk got. An invalidated walk ranks half a stage below a live
      one at the same depth, so a dead SELL can never hide a live BUY. */
  const rankWalk = r => (r.invalidated ? r.stage - 0.5 : r.stage);

  /** Distance of the level a walk selected, for breaking rank ties. */
  const walkDist = r => (r && r.evidence && r.evidence.level)
    ? r.evidence.level.distanceAtr : Infinity;

  /**
   * Walk one direction. Several levels can be candidates at once, so each is
   * walked and the one that got furthest is reported.
   *
   * WHY MORE THAN ONE CANDIDATE. The nearest level is the obvious candidate,
   * but a level that has ALREADY been swept stays a candidate however far
   * price has since travelled — a working setup must not be dropped the moment
   * it starts to pay, which is exactly what "always take the nearest" would do.
   */
  function walk(dir, S, levels, ctx) {
    const buy = dir > 0;
    const side = buy ? 'low' : 'high';
    const price = ctx.price;
    const a15 = ctx.A15[ctx.A15.length - 1] || 0;

    /* Candidates are levels on the correct side of price that have not been
       closed through. A CONSUMED level is not a level any more. */
    const pool = levels.filter(l => l.side === side && l.state !== 'CONSUMED' &&
                                    (buy ? l.price < price + a15 : l.price > price - a15));
    if (!pool.length) {
      return { dir: dir, stage: 0, evidence: {}, code: 'NO_LEVEL',
               why: 'No un-broken important ' + (buy ? 'low below' : 'high above') +
                    ' price to work from.' };
    }

    /* Nearest first; among equals the better-rated one wins. */
    pool.sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price) ||
                        y.ratingScore - x.ratingScore);

    /* Two kinds of candidate, for two different reasons:

         where price IS   — the nearest levels, which is where a new setup
                            would start;
         where price WENT — the levels closest to the extreme of the scan
                            window, which is where a sweep would have happened.

       Only taking the nearest would quietly drop a setup that has already
       swept and started to run, because by then several untouched lows can sit
       between price and the low it actually swept. */
    const win = m15Window(S['15m']);
    const nearExtreme = pool.slice().sort((x, y) =>
      Math.abs(x.price - (buy ? win.low : win.high)) -
      Math.abs(y.price - (buy ? win.low : win.high)));
    const fresh = ctx.asOf - CFG.expiryBars * tfMs('15m');

    const cands = pool.slice(0, 3)
      .concat(nearExtreme.slice(0, 3))
      .concat(pool.filter(l => l.state === 'SWEPT' &&
                               (l.sweptAt == null || l.sweptAt >= fresh)))
      .filter((l, i, a) => a.indexOf(l) === i)
      .slice(0, 10);

    let best = null;
    cands.forEach(l => {
      const r = walkLevel(dir, l, S, levels, ctx);
      if (!best || rankWalk(r) > rankWalk(best) ||
          (rankWalk(r) === rankWalk(best) && walkDist(r) < walkDist(best))) best = r;
    });
    return best;
  }

  /**
   * Walk one direction's mandatory sequence against ONE level.
   *
   *   dir = +1  BUY from an important LOW  (sweep below, reclaim, bullish M5)
   *   dir = -1  SELL from an important HIGH (sweep above, reclaim, bearish M5)
   *
   * Each stage starts from the bar the previous stage completed on. A stage
   * that fails stops the walk and states why, so nothing downstream can be
   * reported without the evidence for everything upstream.
   */
  function walkLevel(dir, level, S, levels, ctx) {
    const buy = dir > 0;
    const ev = {};
    const m15 = S['15m'], m5 = S['5m'], m1 = S['1m'];
    const stop = (stage, code, why) =>
      ({ dir: dir, stage: STAGE_N[stage] - 1, evidence: ev, code: code, why: why });

    const A15 = ctx.A15, a15 = A15[A15.length - 1] || 0;
    const price = ctx.price;

    /* -------------------------------------------------- 1 · IMPORTANT LEVEL */
    const distAtr = a15 ? Math.abs(price - level.price) / a15 : Infinity;
    const near = distAtr <= CFG.nearAtr;
    ev.level = { level: level, distance: Math.abs(price - level.price), distanceAtr: distAtr,
                 near: near, threshold: CFG.nearAtr, validFrom: level.validFrom };

    /* CAUSALITY GATE. The scan may not begin before the level existed. A
       candle that opened earlier cannot touch it, sweep it, reclaim it, reject
       from it, break it or invalidate it - it was not there. */
    const validIdx = firstBarFrom(m15, level.validFrom);
    if (validIdx < 0) {
      return stop('LEVEL', 'NOT_AT_LEVEL',
        level.label + ' at ' + ctx.f(level.price) + ' became valid at ' +
        new Date(level.validFrom).toISOString().slice(11, 16) +
        ' UTC; no M15 candle has opened since.');
    }

    /* Historical contact IDENTIFIES a candidate level. It does not keep the
       setup alive: that is what `near` is for, checked against the price now. */
    const from = Math.max(1, m15.length - CFG.sweepWindow, validIdx);
    let touchIdx = -1;
    for (let i = from; i < m15.length; i++) {
      const a = A15[i] || a15;
      const reached = buy ? m15[i].l <= level.price + CFG.levelTolAtr * a
                          : m15[i].h >= level.price - CFG.levelTolAtr * a;
      if (reached) { touchIdx = i; break; }
    }
    if (touchIdx >= 0) ev.touch = { index: touchIdx, t: m15[touchIdx].t };

    /* --------------------------------------------------------- 2 · SWEEP ---
       A sweep is a penetration that comes back. A penetration that closes
       beyond and stays there is a break, and it kills the level instead of
       setting up a reversal from it. */
    let sweepIdx = -1, extreme = null, penetration = 0;
    for (let i = touchIdx >= 0 ? touchIdx : from; i < m15.length; i++) {
      const a = A15[i] || a15;
      const beyond = buy ? m15[i].l < level.price - CFG.sweepMinAtr * a
                         : m15[i].h > level.price + CFG.sweepMinAtr * a;
      if (!beyond) continue;
      sweepIdx = i;
      extreme = buy ? m15[i].l : m15[i].h;
      penetration = (buy ? level.price - extreme : extreme - level.price) / (a || 1);
      break;
    }

    /* ------------------------------------------------- the proximity gate ---
       Before any sweep, the setup is only live while price is actually AT the
       level. A level price visited nine hours ago and has since left by ten
       ATR is history, not a setup — reporting WATCHING there is how a panel
       ends up recommending a buy a hundred points above the low it named.

       This gate applies ONLY before a sweep. Once liquidity has genuinely been
       taken, the sequence continues no matter where price travels: the whole
       point of the strategy is that price leaves the level fast. */
    if (sweepIdx < 0) {
      if (!near) {
        return stop('LEVEL', 'TOO_FAR',
          'Nearest ' + (buy ? 'low' : 'high') + '-side setup is too far away (' +
          distAtr.toFixed(1) + ' ATR from ' + level.label + ' at ' + ctx.f(level.price) +
          '). Watching needs ' + CFG.nearAtr.toFixed(1) + ' ATR or closer.');
      }
      if (touchIdx < 0) {
        return stop('SWEEP', 'WAITING_SWEEP',
          'Price is within ' + distAtr.toFixed(1) + ' ATR of ' + level.label + ' at ' +
          ctx.f(level.price) + ' but has not reached it yet.');
      }
      return stop('SWEEP', 'WAITING_SWEEP',
        'Price is at ' + level.label + ' but the ' + (buy ? 'sell-side' : 'buy-side') +
        ' liquidity ' + (buy ? 'below' : 'above') + ' it has not been taken yet.');
    }

    /* The extreme of the sweep run — the risk point — is the furthest the move
       went while it was still outside the level. */
    let runEnd = sweepIdx;
    for (let i = sweepIdx; i < Math.min(m15.length, sweepIdx + CFG.reclaimWindow + 1); i++) {
      const beyond = buy ? m15[i].l < level.price : m15[i].h > level.price;
      if (!beyond) break;
      extreme = buy ? Math.min(extreme, m15[i].l) : Math.max(extreme, m15[i].h);
      runEnd = i;
    }

    /* Reclaim: a CLOSE back through the level within the window. */
    let reclaimIdx = -1;
    for (let i = sweepIdx; i < Math.min(m15.length, sweepIdx + CFG.reclaimWindow + 1); i++) {
      if (buy ? m15[i].c > level.price : m15[i].c < level.price) { reclaimIdx = i; break; }
    }

    const sw = m15[sweepIdx];
    const range = Math.max(1e-12, sw.h - sw.l);
    const wick = (buy ? Math.min(sw.o, sw.c) - sw.l : sw.h - Math.max(sw.o, sw.c)) / range;
    ev.sweep = {
      index: sweepIdx, t: sw.t, level: level.price, extreme: extreme,
      penetrationAtr: penetration, wick: wick, runEndIndex: runEnd,
      reclaimed: reclaimIdx >= 0,
      reclaimIndex: reclaimIdx, reclaimT: reclaimIdx >= 0 ? m15[reclaimIdx].t : null,
      rejection: reclaimIdx >= 0 || wick >= CFG.rejectWick
    };

    if (reclaimIdx < 0) {
      const closedBeyond = buy ? sw.c < level.price - CFG.sweepMinAtr * (A15[sweepIdx] || a15)
                               : sw.c > level.price + CFG.sweepMinAtr * (A15[sweepIdx] || a15);
      const barsSince = m15.length - 1 - sweepIdx;
      if (closedBeyond && barsSince >= CFG.reclaimWindow) {
        /* A break only INVALIDATES something that was a setup. If it happened
           long ago and price is nowhere near the level now, nothing died just
           now — the level is simply history, and saying "INVALIDATED" would
           put a red banner on the page for a thing that stopped mattering
           hours ago. */
        if (near || barsSince <= CFG.reclaimWindow * 3) {
          return { dir: dir, stage: STAGE_N.SWEEP - 1, evidence: ev, invalidated: true,
                   code: 'LEVEL_BROKEN',
                   why: level.label + ' was closed through and not reclaimed within ' +
                        CFG.reclaimWindow + ' M15 candles. That is a break, not a sweep — ' +
                        'this level is no longer valid for a reversal.' };
        }
        return stop('LEVEL', 'TOO_FAR',
          'Nearest ' + (buy ? 'low' : 'high') + '-side setup is too far away (' +
          distAtr.toFixed(1) + ' ATR from ' + level.label + ' at ' + ctx.f(level.price) +
          '), and that level was closed through ' + barsSince +
          ' M15 candles ago. Watching needs ' + CFG.nearAtr.toFixed(1) +
          ' ATR or closer.');
      }
      if (!near && barsSince > CFG.reclaimWindow * 3) {
        return stop('LEVEL', 'TOO_FAR',
          'Nearest ' + (buy ? 'low' : 'high') + '-side setup is too far away (' +
          distAtr.toFixed(1) + ' ATR from ' + level.label + ' at ' + ctx.f(level.price) +
          '). Watching needs ' + CFG.nearAtr.toFixed(1) + ' ATR or closer.');
      }
      return stop('SWEEP', 'WAITING_RECLAIM',
        'Liquidity was taken at ' + ctx.f(extreme) + ' but price has not closed back ' +
        (buy ? 'above ' : 'below ') + level.label + ' yet.');
    }

    /* Stale: a sweep that never produced structure stops being tradeable. */
    const barsSinceSweep = m15.length - 1 - sweepIdx;
    const expired = barsSinceSweep > CFG.expiryBars;

    /* --------------------------------------- 3 · M5 CHOCH / BOS, ON A CLOSE */
    const sweepT = m15[runEnd].t + tfMs('15m');   // the sweep run is complete here
    const c0 = indexFromTime(m5, sweepT);
    if (c0 < 0) return stop('STRUCT', 'WAITING_STRUCTURE',
      'The sweep is confirmed. Waiting for M5 candles after it to close.');

    const A5 = VPR.atrSeries(m5, CFG.atrLen);
    /* Structure before the sweep decides whether a break is a CHANGE of
       character or a continuation of one. Read on closed candles only. */
    const preBias = VPR.structureBias(m5.slice(0, c0 + 1));

    /* The swing the break has to clear, confirmed by VPR.swings — which needs
       k bars on BOTH sides, so it can never be a bar that has not closed. */
    let brokeIdx = -1, brokenSwing = null, kind = null, dispBar = null;
    const scanEnd = Math.min(m5.length - 1, c0 + CFG.confirmWindow);
    for (let i = c0; i <= scanEnd; i++) {
      const upTo = m5.slice(0, i);                       // strictly before bar i
      if (upTo.length < 3 * CFG.swingK + 2) continue;
      const pv = VPR.swings(upTo, CFG.swingK, Math.max(0, upTo.length - 120));
      const arr = buy ? pv.highs : pv.lows;
      /* the most recent confirmed swing that formed at or after the sweep */
      const cand = arr.filter(p => p.t >= m5[c0].t).pop() || last(arr);
      if (!cand) continue;
      const a = A5[i] || 0;
      const cleared = buy ? m5[i].c > cand.price + CFG.breakMarginAtr * a
                          : m5[i].c < cand.price - CFG.breakMarginAtr * a;
      if (!cleared) continue;
      brokeIdx = i; brokenSwing = cand;
      kind = (preBias.dir === dir) ? 'BOS' : 'CHOCH';
      const b = m5[i], body = Math.abs(b.c - b.o), rng = Math.max(1e-12, b.h - b.l);
      dispBar = { body: body, bodyAtr: a ? body / a : 0, bodyPct: body / rng,
                  displaced: a ? (body / a >= CFG.dispBodyAtr && body / rng >= CFG.dispBodyPct)
                               : false };
      break;
    }

    if (brokeIdx < 0) {
      if (expired) {
        return { dir: dir, stage: STAGE_N.SWEEP, evidence: ev, invalidated: true,
                 code: 'EXPIRED',
                 why: 'The sweep at ' + ctx.f(extreme) + ' is ' + barsSinceSweep +
                      ' M15 candles old and M5 structure never turned. Setup expired.' };
      }
      /* Failure: price went back through the swept extreme before structure
         turned. The reversal premise is gone. */
      let failed = false;
      for (let i = c0; i < m5.length; i++) {
        if (buy ? m5[i].c < extreme : m5[i].c > extreme) { failed = true; break; }
      }
      if (failed) {
        return { dir: dir, stage: STAGE_N.SWEEP, evidence: ev, invalidated: true,
                 code: 'STRUCTURE_FAILED',
                 why: 'An M5 candle closed back through the swept extreme at ' +
                      ctx.f(extreme) + ' before structure turned.' };
      }
      return stop('STRUCT', 'WAITING_STRUCTURE',
        'Liquidity was swept and reclaimed. Waiting for a ' +
        (buy ? 'bullish' : 'bearish') + ' M5 CHOCH or BOS to CLOSE. ' +
        'No candle close, no entry.');
    }

    /* The impulse the break produced — the leg the pullback is measured on. */
    let legHi = -Infinity, legLo = Infinity;
    for (let i = c0; i <= brokeIdx; i++) {
      legHi = Math.max(legHi, m5[i].h); legLo = Math.min(legLo, m5[i].l);
    }
    legHi = Math.max(legHi, buy ? m5[brokeIdx].c : legHi);
    legLo = Math.min(legLo, buy ? legLo : m5[brokeIdx].c);
    const impulse = buy ? { from: Math.min(legLo, extreme), to: legHi }
                        : { from: Math.max(legHi, extreme), to: legLo };

    ev.structure = {
      index: brokeIdx, t: m5[brokeIdx].t, kind: kind,
      brokenSwing: brokenSwing.price, brokenSwingT: brokenSwing.t,
      close: m5[brokeIdx].c, preBias: preBias.label,
      displacement: dispBar,
      candleClosed: m5[brokeIdx].t + tfMs('5m') <= ctx.asOf,
      impulse: impulse
    };

    /* ------------------------------------------------ 4 · M1 PULLBACK ----- */
    const span = Math.abs(impulse.to - impulse.from);
    const zone = buy
      ? { lo: impulse.to - span * CFG.pullbackMax, hi: impulse.to - span * CFG.pullbackMin }
      : { lo: impulse.to + span * CFG.pullbackMin, hi: impulse.to + span * CFG.pullbackMax };
    const aStop = A5[brokeIdx] || 0;
    const sl = buy ? extreme - CFG.stopBufferAtr * aStop
                   : extreme + CFG.stopBufferAtr * aStop;

    const e0 = indexFromTime(m1, m5[brokeIdx].t + tfMs('5m'));
    let pullIdx = -1;
    if (e0 >= 0) {
      const stopAt = Math.min(m1.length - 1, e0 + CFG.entryWindow);
      for (let i = e0; i <= stopAt; i++) {
        if (m1[i].l <= zone.hi && m1[i].h >= zone.lo) { pullIdx = i; break; }
      }
    }

    /* Invalidation outranks progress: a close through the stop ends it. */
    if (e0 >= 0) {
      for (let i = e0; i < m1.length; i++) {
        if (buy ? m1[i].c < sl : m1[i].c > sl) {
          return { dir: dir, stage: STAGE_N.STRUCT, evidence: ev, invalidated: true,
                   code: 'STRUCTURE_FAILED',
                   why: 'Price closed through the protective level at ' + ctx.f(sl) +
                        ' after the M5 ' + kind + '. The setup is invalidated.' };
        }
      }
    }

    /* Confluence is scored, never required. */
    const conf = confluence(dir, m1, zone, m5[brokeIdx].t);
    ev.entry = {
      zone: zone, sl: sl, impulse: impulse,
      pullback: pullIdx >= 0 ? { index: pullIdx, t: m1[pullIdx].t } : null,
      fvg: conf.fvg, ob: conf.ob
    };

    if (pullIdx < 0) {
      return stop('PULLBACK', 'WAITING_PULLBACK',
        'M5 ' + kind + ' confirmed. Waiting for an M1 pullback into ' +
        ctx.f(zone.lo) + '–' + ctx.f(zone.hi) + '.');
    }

    /* ------------------------------------------------------- 5 · TARGETS -- */
    const entry = buy ? Math.min(zone.hi, price) : Math.max(zone.lo, price);
    const risk = Math.abs(entry - sl);
    /* A target has to have existed when the entry did. Without this the plan
       repaints: the rally that follows the entry creates a new swing, and that
       new swing becomes the TP the entry is judged against. */
    const readyAt = m1[pullIdx].t + tfMs('1m');
    const targets = pickTargets(dir, entry, risk, levels, ctx, readyAt);
    ev.targets = targets;
    if (!targets.tp1) {
      return stop('ENTRY', 'NO_TARGET',
        'No opposing liquidity above the entry to target. The engine will not ' +
        'invent one.');
    }
    ev.entry.entry = entry;
    ev.entry.risk = risk;
    ev.entry.rr1 = risk ? Math.abs(targets.tp1.price - entry) / risk : null;
    ev.entry.rr2 = targets.tp2 && risk ? Math.abs(targets.tp2.price - entry) / risk : null;

    return { dir: dir, stage: STAGE_N.ENTRY, evidence: ev, code: 'NONE', why: null };
  }

  /**
   * TP1 / TP2 are real opposing levels from the same level set, not multiples
   * of the stop. If there is nothing to aim at, the setup says so.
   */
  function pickTargets(dir, entry, risk, levels, ctx, knownAt) {
    const buy = dir > 0;
    const want = buy ? 'high' : 'low';
    const cands = levels
      .filter(l => l.side === want && l.state !== 'CONSUMED' &&
                   (knownAt == null || l.validFrom == null || l.validFrom <= knownAt) &&
                   (buy ? l.price > entry + risk * 0.25 : l.price < entry - risk * 0.25))
      .sort((a, b) => buy ? a.price - b.price : b.price - a.price);
    return {
      tp1: cands[0] || null,
      tp2: cands[1] || null,
      considered: cands.length
    };
  }

  /** FVGs and order blocks overlapping the entry zone, from the shared detectors. */
  function confluence(dir, m1, zone, afterT) {
    const buy = dir > 0;
    const out = { fvg: [], ob: [] };
    const lastClosed = m1.length - 1;
    const overlaps = z => z.lo <= zone.hi && z.hi >= zone.lo;
    try {
      if (global.AUTODRAW && AUTODRAW.detect && AUTODRAW.detect.detectFVG) {
        out.fvg = AUTODRAW.detect.detectFVG(m1, '1m', lastClosed, 400)
          .filter(g => g.type === (buy ? 'bull' : 'bear') && g.t0 >= afterT &&
                       g.state !== 'INVALIDATED' && g.state !== 'MITIGATED' && overlaps(g))
          .map(g => ({ lo: g.lo, hi: g.hi, t0: g.t0, t1: g.t1, state: g.state,
                       sizeAtr: g.sizeAtr }));
      }
    } catch (e) { /* a detector refusing is not evidence of a gap */ }
    try {
      if (global.ZONES && ZONES.detectOB) {
        out.ob = ZONES.detectOB(m1, '1m', lastClosed)
          .filter(o => o.type === (buy ? 'bullish' : 'bearish') &&
                       o.state !== 'MITIGATED' && overlaps(o))
          .map(o => ({ lo: o.lo, hi: o.hi, time: o.time, state: o.state, score: o.score }));
      }
    } catch (e) { /* same */ }
    return out;
  }

  /* ==================================================================== SCORE
     Every component is 0..1 and multiplied by its stated maximum. A component
     whose evidence does not exist scores zero rather than being skipped, so
     the total always means the same thing. */
  function scoreOf(res, ctx) {
    const ev = res.evidence, dir = res.dir, buy = dir > 0;
    const parts = {};

    /* Higher-timeframe structure is SCORED, never a veto. A liquidity reversal
       can legitimately trade against the previous trend — that is what a
       reversal is. So a disagreeing H4 or H1 costs points and is named in
       `conflicts`, and the mandatory sweep and M5 confirmation are still
       required either way. What it must never do is read as alignment. */
    const h4 = ctx.direction.dir, h1 = ctx.h1.dir;
    parts.htf = ((h4 === dir ? 0.6 : h4 === 0 ? 0.3 : 0) +
                 (h1 === dir ? 0.4 : h1 === 0 ? 0.2 : 0));
    const word = v => v === dir ? 'with' : v === 0 ? 'neutral to' : 'against';
    parts.htfDetail = 'H4 ' + ctx.direction.label + ' (' + word(h4) + ' this ' +
      (buy ? 'BUY' : 'SELL') + '), H1 ' + ctx.h1.label + ' (' + word(h1) + ')';

    parts.level = ev.level ? clamp01(ev.level.level.ratingScore) : 0;

    parts.sweep = ev.sweep
      ? clamp01(Math.min(1, ev.sweep.penetrationAtr / 0.75) * 0.6 +
                (ev.sweep.reclaimed ? 0.4 : 0))
      : 0;

    parts.reject = ev.sweep
      ? clamp01(clamp01(ev.sweep.wick / CFG.rejectWick) * 0.5 +
                (ev.structure && ev.structure.displacement
                  ? clamp01(ev.structure.displacement.bodyAtr / CFG.dispBodyAtr) * 0.5 : 0))
      : 0;

    parts.m5 = ev.structure
      ? clamp01((ev.structure.kind === 'CHOCH' ? 0.6 : 0.45) +
                (ev.structure.displacement && ev.structure.displacement.displaced ? 0.4 : 0))
      : 0;

    parts.m1 = ev.entry && ev.entry.pullback
      ? clamp01(0.6 + (ev.entry.rr1 ? clamp01((ev.entry.rr1 - 1) / 2) * 0.4 : 0))
      : 0;

    parts.conf = ev.entry
      ? clamp01((ev.entry.fvg.length ? 0.6 : 0) + (ev.entry.ob.length ? 0.4 : 0))
      : 0;

    const rows = SCORE_WEIGHTS.map(w => ({
      key: w.key, label: w.label, max: w.max,
      points: Math.round(clamp01(parts[w.key]) * w.max),
      detail: w.key === 'htf' ? parts.htfDetail : null
    }));
    return {
      total: rows.reduce((s, r) => s + r.points, 0),
      rows: rows,
      note: 'Score describes quality only. It cannot create a signal: a missing ' +
            'mandatory condition blocks the entry at any score.'
    };
  }

  /* ============================================================== the pipeline
     One row per mandatory stage, with the live pass/fail the UI paints.

       PENDING  nothing is happening here (inactive)
       ACTIVE   this is the condition currently being waited on
       DONE     the condition passed, on the direction's own colour
       DEAD     the setup that reached here has been invalidated

     A stage is only ACTIVE when the walk is genuinely standing on the previous
     one. With nothing live — no level near enough, no candidate at all — every
     box is PENDING, because a level merely existing somewhere on the chart is
     not a setup in progress. */
  function pipeline(dir, res, confirmed) {
    const buy = dir > 0;
    const reached = res ? res.stage : 0;
    const dead = !!(res && res.invalidated);
    return STAGES.map(s => {
      let state;
      if (s.key === 'ENTRY') {
        /* the final box only lights when the signal is actually confirmed —
           reaching stage 5 in the walk is necessary, not sufficient */
        state = confirmed ? 'DONE'
              : reached >= s.n ? (dead ? 'DEAD' : 'ACTIVE')
              : 'PENDING';
      } else if (s.n <= reached) {
        state = dead ? 'DEAD' : 'DONE';
      } else if (!dead && reached >= 1 && s.n === reached + 1) {
        state = 'ACTIVE';
      } else {
        state = 'PENDING';
      }
      return { n: s.n, key: s.key, label: buy ? s.buy : s.sell, state: state };
    });
  }

  /**
   * One side's walk, flattened. Reported for BOTH directions whichever one the
   * page ends up showing, so "why isn't this a buy?" is always answerable
   * without re-running anything.
   */
  function candidateOf(r) {
    const l = r && r.evidence && r.evidence.level;
    return {
      stage: r ? r.stage : 0,
      code: r ? r.code : 'NO_LEVEL',
      why: r ? r.why : null,
      invalidated: !!(r && r.invalidated),
      levelKey: l ? l.level.key : null,
      levelLabel: l ? l.level.label : null,
      levelPrice: l ? l.level.price : null,
      distanceAtr: l ? l.distanceAtr : null,
      near: l ? l.near : null,
      swept: !!(r && r.evidence && r.evidence.sweep)
    };
  }

  /* ================================================================= analyze */

  /**
   * input: { symbol, digits, series:{1m,5m,15m,1h,4h}, asOf, health }
   * Every reported number is measured from those candles. Nothing is defaulted
   * to a plausible-looking value: where a measurement cannot be made the field
   * is null and the UI shows WAITING FOR DATA.
   */
  function analyze(input) {
    const asOf = input.asOf == null ? Date.now() : input.asOf;
    const digits = input.digits == null ? 2 : input.digits;
    const f = p => VPR.fmtN(p, digits);

    const out = {
      ok: false, symbol: input.symbol, asOf: asOf, digits: digits,
      signal: 'NO_DATA', signalLabel: SIGNALS.NO_DATA, direction: null,
      price: null, levels: [], headline: [], score: null,
      pipeline: { buy: pipeline(1, null, false), sell: pipeline(-1, null, false) },
      health: input.health || { status: 'live' }
    };

    /* --- closed candles only, every interval, one door ------------------- */
    const S = {};
    let missing = null;
    REQUIRED_TFS.forEach(tf => {
      S[tf] = VPR.closedAt(input.series && input.series[tf], tfMs(tf), asOf);
      if (!missing && S[tf].length < CFG.minBars[tf]) {
        missing = tf.toUpperCase() + ' (' + S[tf].length + ' of ' + CFG.minBars[tf] +
                  ' closed candles)';
      }
    });
    if (missing) {
      out.reason = 'Waiting for data: ' + missing + '.';
      out.series = S;
      return out;
    }

    const price = last(S['15m']).c;
    const A15 = VPR.atrSeries(S['15m'], CFG.atrLen);

    const dir4 = direction(S['4h']);
    const set = levelSet(S['1h'], S['15m'], asOf);
    const bias1 = h1Bias(S['1h'], set);
    const sess = VPR.sessions(asOf, S['15m'], tfMs('15m'));

    const ctx = { price: price, asOf: asOf, digits: digits, f: f, A15: A15,
                  direction: dir4, h1: bias1 };

    /* --- both sides are walked; neither is assumed from the level alone -- */
    const buyRes  = walk(+1, S, set, ctx);
    const sellRes = walk(-1, S, set, ctx);

    /* The more advanced walk is reported. An invalidated walk is reported only
       when it got further than the other side, so a dead SELL cannot hide a
       live BUY. With neither side live, the nearer of the two is reported —
       that is the one the "too far" message should be about. */
    let res;
    if (rankWalk(buyRes) !== rankWalk(sellRes)) {
      res = rankWalk(buyRes) > rankWalk(sellRes) ? buyRes : sellRes;
    } else {
      res = walkDist(buyRes) <= walkDist(sellRes) ? buyRes : sellRes;
    }

    const dir = res.stage > 0 || res.invalidated ? res.dir : 0;
    const buy = dir > 0;

    /* --------------------------------------------------- mandatory gating --
       This is the only place a signal is allowed to become CONFIRMED, and it
       reads the stage counter, never the score. */
    const ev = res.evidence || {};
    const mandatory = [
      { key: 'level',    label: buy ? 'Important low identified' : 'Important high identified',
        pass: !!ev.level && !!ev.touch },
      { key: 'sweep',    label: buy ? 'Sell-side liquidity swept' : 'Buy-side liquidity swept',
        pass: !!ev.sweep },
      { key: 'reclaim',  label: 'Rejection / reclaim of the level',
        pass: !!(ev.sweep && ev.sweep.reclaimed) },
      { key: 'm5',       label: (buy ? 'Bullish' : 'Bearish') + ' M5 CHOCH/BOS on a closed candle',
        pass: !!(ev.structure && ev.structure.candleClosed) },
      { key: 'pullback', label: 'M1 pullback into the entry zone',
        pass: !!(ev.entry && ev.entry.pullback) },
      { key: 'target',   label: 'A real opposing level to target',
        pass: !!(ev.targets && ev.targets.tp1) }
    ];
    const allPass = mandatory.every(m => m.pass);

    /* Feed gating, borrowed from the VPR engine so the two pages cannot
       disagree about what "live" means. A frozen quote cannot tell you price
       reached the entry. */
    const health = input.health || { status: 'live' };
    const signalsLive = !!VPR.LIVE_STATES[health.status];

    let code = res.code || 'NONE';
    let signal;
    if (res.invalidated) {
      signal = 'INVALIDATED';
    } else if (allPass && res.stage >= STAGE_N.ENTRY) {
      if (!signalsLive) {
        signal = 'WAITING';
        code = VPR.HEALTH_BLOCKER[health.status] || 'DISCONNECTED';
      } else {
        signal = buy ? 'BUY_CONFIRMED' : 'SELL_CONFIRMED';
        code = 'NONE';
      }
    } else if (res.stage >= STAGE_N.SWEEP) {
      /* liquidity taken, structure not yet proven — this is WAIT, not a trade */
      signal = 'WAITING';
    } else if (res.stage >= STAGE_N.LEVEL) {
      signal = buy ? 'WATCHING_BUY' : 'WATCHING_SELL';
    } else {
      signal = 'NO_SETUP';
    }

    const confirmed = signal === 'BUY_CONFIRMED' || signal === 'SELL_CONFIRMED';
    const score = dir !== 0 ? scoreOf(res, ctx) : null;

    /* --------------------------------------------------------- M15 / M5 / M1
       Card-shaped views of the SAME evidence. They cannot disagree with the
       gate above because they read the same object. */
    const m15card = {
      status: signal === 'NO_SETUP' ? 'NO SETUP'
            : signal === 'INVALIDATED' ? 'INVALIDATED'
            : confirmed ? (buy ? 'BUY CONFIRMED' : 'SELL CONFIRMED')
            : dir === 0 ? 'NO SETUP'
            : res.stage >= STAGE_N.SWEEP ? (buy ? 'SSL SWEPT' : 'BSL SWEPT')
            : (buy ? 'WATCHING BUY' : 'WATCHING SELL'),
      level: ev.level ? ev.level.level : null,
      distanceAtr: ev.level ? ev.level.distanceAtr : null,
      near: ev.level ? ev.level.near : null,
      nearAtr: CFG.nearAtr,
      atr: A15[A15.length - 1] || 0,
      sweep: ev.sweep || null,
      rejection: ev.sweep ? (ev.sweep.reclaimed ? 'Reclaimed'
                            : ev.sweep.rejection ? 'Wick rejection, no reclaim yet'
                            : 'Waiting') : 'Waiting',
      quality: score ? clamp01((score.rows.find(r => r.key === 'sweep').points / 15) * 0.5 +
                               (score.rows.find(r => r.key === 'reject').points / 15) * 0.5)
                     : null,
      note: dir === 0
        ? (res.code === 'TOO_FAR'
            ? 'The level is still on the chart — price is just not at it. A level ' +
              'existing is not a setup running.'
            : 'No un-broken level is close enough to work from.')
        : 'This card can never confirm a trade on its own. M5 structure decides.'
    };

    const m5card = {
      status: ev.structure ? 'CONFIRMED' : res.stage >= STAGE_N.SWEEP ? 'WAITING' : 'WAITING',
      kind: ev.structure ? ev.structure.kind : null,
      brokenSwing: ev.structure ? ev.structure.brokenSwing : null,
      displacement: ev.structure ? ev.structure.displacement : null,
      candleClose: ev.structure
        ? (ev.structure.candleClosed ? 'Confirmed on close' : 'Required')
        : 'Required',
      structure: ev.structure
        ? (buy ? 'Bullish ' : 'Bearish ') + ev.structure.kind + ' from ' +
          ev.structure.preBias.toLowerCase() + ' M5 structure'
        : dir === 0 ? null
        : (buy ? 'Bullish setup possible' : 'Bearish setup possible'),
      note: 'No candle close, no entry.'
    };

    const m1card = {
      status: ev.entry && ev.entry.pullback ? (confirmed ? 'CONFIRMED' : 'WAITING') : 'WAITING',
      allowed: !!ev.structure,
      pullback: ev.entry && ev.entry.pullback ? 'Detected'
              : ev.structure ? 'Not yet' : 'Blocked until M5 confirms',
      fvgOb: !ev.entry ? null
           : (ev.entry.fvg.length || ev.entry.ob.length)
             ? [ev.entry.fvg.length ? ev.entry.fvg.length + ' FVG' : null,
                ev.entry.ob.length ? ev.entry.ob.length + ' OB' : null]
               .filter(Boolean).join(' · ')
             : 'Scanning',
      zone: ev.entry ? ev.entry.zone : null,
      sl: ev.entry ? ev.entry.sl : null,
      entry: ev.entry ? ev.entry.entry : null,
      tp1: ev.targets ? ev.targets.tp1 : null,
      tp2: ev.targets ? ev.targets.tp2 : null,
      rr1: ev.entry ? ev.entry.rr1 : null,
      rr2: ev.entry ? ev.entry.rr2 : null,
      note: 'M1 is only read after M5 confirms. It never creates a direction.'
    };

    /* Trade levels are withheld until the signal is actually confirmed — which
       also means a stale feed withholds them, because the gate reads health. */
    const levelsOut = confirmed && ev.entry ? {
      entry: ev.entry.entry, sl: ev.entry.sl, zone: ev.entry.zone,
      tp1: ev.targets.tp1 ? ev.targets.tp1.price : null,
      tp2: ev.targets.tp2 ? ev.targets.tp2.price : null,
      rr1: ev.entry.rr1, rr2: ev.entry.rr2
    } : null;

    const conflicts = [];
    if (dir !== 0 && dir4.dir && dir4.dir !== dir) {
      conflicts.push('H4 structure is ' + dir4.label.toLowerCase() + ', against this ' +
                     (buy ? 'BUY' : 'SELL') + '.');
    }
    if (dir !== 0 && bias1.dir && bias1.dir !== dir) {
      conflicts.push('H1 structure is ' + bias1.label.toLowerCase() + ', against this ' +
                     (buy ? 'BUY' : 'SELL') + '.');
    }
    if (confirmed && ev.entry && ev.entry.rr1 != null && ev.entry.rr1 < CFG.minRR) {
      conflicts.push('R:R to TP1 is ' + ev.entry.rr1.toFixed(2) + ', below the stated ' +
                     CFG.minRR + ' minimum.');
    }

    return Object.assign(out, {
      ok: true,
      price: price,
      atr15: A15[A15.length - 1] || 0,
      signal: signal,
      signalLabel: SIGNALS[signal],
      direction: dir === 0 ? null : buy ? 'BUY' : 'SELL',
      confirmed: confirmed,
      stage: res.stage,
      blockerCode: code,
      blocker: BLOCKERS[code] || code,
      blockedBy: res.why || null,
      mandatory: mandatory,
      signalsLive: signalsLive,
      h4: dir4,
      h1: bias1,
      session: sess,
      levels: set,
      headline: headlineLevels(set),
      /* A LEVEL EXISTING and A SETUP BEING LIVE AT IT are different things. The
         chart draws every level either way; only this one gets the highlight. */
      activeLevel: (res.stage >= STAGE_N.LEVEL && ev.level) ? ev.level.level.key : null,
      nearAtr: CFG.nearAtr,
      m15: m15card,
      m5: m5card,
      m1: m1card,
      evidence: ev,
      score: score,
      tradeLevels: levelsOut,
      conflicts: conflicts,
      candidates: { buy: candidateOf(buyRes), sell: candidateOf(sellRes) },
      pipeline: { buy: pipeline(1, buyRes, signal === 'BUY_CONFIRMED'),
                  sell: pipeline(-1, sellRes, signal === 'SELL_CONFIRMED') },
      lastBarTime: last(S['15m']).t,
      series: S
    });
  }

  /* ISOLATION (not a strategy change): the XAUUSD engine owns `global.HLR`. This one takes
     its own name so the two can never overwrite each other if they are ever loaded in the
     same process. Every rule, weight and threshold below is unchanged. */
  global.GCHLR = {
    TF, REQUIRED_TFS, CFG, STAGES, STAGE_N, SIGNALS, BLOCKERS,
    RATING_WEIGHTS, KIND_WEIGHT, RATING_BANDS, SCORE_WEIGHTS, HEADLINE,
    analyze, direction, h1Bias, levelSet, headlineLevels, sessionRange, previousDay,
    levelState, rateLevel, ratingOf, walk, walkLevel, rankWalk, scoreOf, pipeline,
    pickTargets, confluence, swingValidFrom, firstBarFrom,
    indexAtTime, indexFromTime, tfMs,
    DISCLAIMER: 'A high is not a sell and a low is not a buy. A level is stage one ' +
                'of five; without a liquidity sweep and an M5 structure confirmation ' +
                'that closed, this engine reports WAIT.'
  };
})(window);
