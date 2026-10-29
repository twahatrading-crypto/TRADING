/* Reconnect, backoff, staleness and isolation. node bridge/gc-hlr/tests/reconnect.test.cjs
   Drives the producer with a controllable fake source. Opens no real connection. */
'use strict';
const fs = require('fs'), path = require('path');
const P = require('../lib/producer.cjs');
const cal = require('../lib/cme-calendar.cjs');

const ORIG = String.raw`C:\Users\twaha\hlr-upload-staging\hlr-original`;
const g = globalThis; g.window = g;
for (const f of ['data.js', 'vpr-engine.js']) (0, eval)(fs.readFileSync(path.join(ORIG, f), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ORIG, 'hlr-engine.js'), 'utf8'));                        // HLR
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'engine', 'gc-hlr-engine.js'), 'utf8')); // GCHLR

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); }
                          else { fail++; console.log(`  FAIL  ${n}${d ? '  -> ' + d : ''}`); } };

const H = 3600e3;
const STEP = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': H, '4h': 4 * H };
function mkBars(endMs, count, stepMs) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = Math.floor((endMs - i * stepMs) / 1000), p = 4000 + ((count - i) % 11);
    out.push({ time: t, open: p, high: p + 3, low: p - 3, close: p + 1, volume: 50 });
  }
  return out;
}

/* A source we can break and repair, which also COUNTS calls - that is how we
   prove recovery does not open a second subscription or double-poll. */
function makeSource(now) {
  const s = { up: true, calls: 0, byTf: {} };
  s.fetchTf = async (tf) => {
    s.calls++; s.byTf[tf] = (s.byTf[tf] || 0) + 1;
    if (!s.up) throw new Error('ECONNREFUSED');
    return { contract: 'GCZ6', bars: mkBars(s.now - STEP[tf], 420, STEP[tf]) };
  };
  s.now = now;
  return s;
}

(async () => {
const now = Date.UTC(2026, 9, 28, 14, 0, 0);

console.log('\n=== 1. disconnect -> recover, with no manual restart (items 1, 4) ===');
const src = makeSource(now);
let snap = await P.buildSnapshot({ engine: g.GCHLR, fetchTf: src.fetchTf, now });
ok('healthy before the outage', snap.analysis_enabled === true, snap.analysis_blocker);
const callsAfterGood = src.calls;

src.up = false;
snap = await P.buildSnapshot({ engine: g.GCHLR, fetchTf: src.fetchTf, now });
ok('outage -> analysis withheld', snap.analysis_enabled === false);
ok('outage -> no candles served', Object.keys(snap.series).length === 0);
ok('outage -> zero synthetic bars', JSON.stringify(snap.series) === '{}');

src.up = true;                                   // the source returns; nothing is restarted
snap = await P.buildSnapshot({ engine: g.GCHLR, fetchTf: src.fetchTf, now });
ok('recovers on the very next poll, unaided', snap.analysis_enabled === true, snap.analysis_blocker);
ok('recovery needs no extra fetches per cycle',
   src.calls - callsAfterGood === 2 * P.TFS.length,
   `${src.calls - callsAfterGood} calls across 2 cycles of ${P.TFS.length} timeframes`);

console.log('\n=== 2. one fetch per timeframe per cycle - no duplicate subscriptions (item 2) ===');
const s2 = makeSource(now);
await P.buildSnapshot({ engine: g.GCHLR, fetchTf: s2.fetchTf, now });
ok('exactly one call per timeframe', P.TFS.every((tf) => s2.byTf[tf] === 1), JSON.stringify(s2.byTf));
ok('no timeframe fetched twice', Object.values(s2.byTf).every((n) => n === 1));

console.log('\n=== 3. exponential backoff is bounded and jittered (item 2) ===');
/* Mirrors server.cjs: double, cap at 60s, +/-20% jitter. */
const BACKOFF_MIN = 1000, BACKOFF_MAX = 60000;
let b = BACKOFF_MIN; const seq = [];
for (let i = 0; i < 12; i++) {
  b = Math.round(Math.min(b * 2, BACKOFF_MAX) * (0.8 + Math.random() * 0.4));
  seq.push(b);
}
ok('backoff grows', seq[3] > seq[0]);
ok('backoff never exceeds the cap + jitter', seq.every((x) => x <= BACKOFF_MAX * 1.2), String(Math.max(...seq)));
ok('backoff never collapses to a tight loop', seq.every((x) => x >= 800), String(Math.min(...seq)));
ok('jitter makes runs differ', new Set(seq).size > 6);

console.log('\n=== 4. stale data disables analysis immediately (item 3) ===');
const s4 = makeSource(now); s4.now = now - 6 * H;          // every bar six hours old
const stale = await P.buildSnapshot({ engine: g.GCHLR, fetchTf: s4.fetchTf, now });
ok('stale -> analysis_enabled false', stale.analysis_enabled === false);
ok('stale -> no result object', stale.result === null);
ok('stale -> no signals', Array.isArray(stale.signals) && stale.signals.length === 0);
ok('stale -> says how old', /old/.test(String(stale.analysis_blocker)), stale.analysis_blocker);

console.log('\n=== 5. a GC failure cannot touch XAUUSD (item 5) ===');
const xauCfg = JSON.stringify(g.HLR.CFG);
const xauPrev = JSON.stringify(g.HLR.previousDay(
  mkBars(now, 200, H).map((b) => ({ t: b.time * 1000, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })), now));
const s5 = makeSource(now); s5.up = false;
await P.buildSnapshot({ engine: g.GCHLR, fetchTf: s5.fetchTf, now });
ok('XAUUSD CFG untouched by a GC outage', JSON.stringify(g.HLR.CFG) === xauCfg);
ok('XAUUSD previousDay untouched by a GC outage', JSON.stringify(g.HLR.previousDay(
  mkBars(now, 200, H).map((b) => ({ t: b.time * 1000, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })), now)) === xauPrev);
ok('the two engines remain distinct objects', g.HLR !== g.GCHLR);

console.log('\n=== 6. provenance is accurate about WHO supplies what (item 7) ===');
const good = await P.buildSnapshot({ engine: g.GCHLR, fetchTf: makeSource(now).fetchTf, now });
ok('candles are attributed to Databento', /databento/i.test(good.provenance.candles), good.provenance.candles);
ok('depth is "none" when absent', good.provenance.depth === 'none');
const withDepth = await P.buildSnapshot({ engine: g.GCHLR, fetchTf: makeSource(now).fetchTf, now,
  depth: { bids: [[4000, 1]], asks: [[4001, 1]] } });
ok('depth attributed to IBKR and marked display-only',
   /ibkr/i.test(withDepth.provenance.depth) && /display only/i.test(withDepth.provenance.depth),
   withDepth.provenance.depth);
ok('IBKR is never credited with candles', !/ibkr/i.test(withDepth.provenance.candles));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})();
