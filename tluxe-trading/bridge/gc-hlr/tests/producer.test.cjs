/* GC HLR producer tests. node bridge/gc-hlr/tests/producer.test.cjs
   Loads the real engines read-only. Writes nothing. Opens no connection. */
'use strict';
const fs = require('fs'), path = require('path');
const cal = require('../lib/cme-calendar.cjs');
const P = require('../lib/producer.cjs');

const ORIG = String.raw`C:\Users\twaha\hlr-upload-staging\hlr-original`;
const g = globalThis; g.window = g;
for (const f of ['data.js', 'vpr-engine.js']) (0, eval)(fs.readFileSync(path.join(ORIG, f), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ORIG, 'hlr-engine.js'), 'utf8'));                 // HLR (XAUUSD)
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'engine', 'gc-hlr-engine.js'), 'utf8')); // GCHLR

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); }
                          else { fail++; console.log(`  FAIL  ${n}${d ? '  -> ' + d : ''}`); } };
const H = 3600e3;

/* A synthetic FIXTURE for deterministic tests. This is test input, never served:
   the producer can only ever emit what a fetcher hands it. */
function mkBars(endMs, count, stepMs, px = 4000) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = Math.floor((endMs - i * stepMs) / 1000);
    const p = px + ((count - i) % 11);
    out.push({ time: t, open: p, high: p + 3, low: p - 3, close: p + 1, volume: 50 });
  }
  return out;
}
const STEP = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': H, '4h': 4 * H };
function fullFetcher(now, contract = 'GCZ6', over = {}) {
  return async (tf) => over[tf] !== undefined ? over[tf]
    : { contract, bars: mkBars(now - STEP[tf], 420, STEP[tf]) };
}

(async () => {
console.log('\n=== 1. CME calendar is a table, not an inference (req 7) ===');
ok('known full closure recognised', cal.sessionStatus(Date.UTC(2026, 11, 25)).status === 'HOLIDAY');
ok('known early close recognised', cal.sessionStatus(Date.UTC(2026, 6, 3)).earlyClose === true);
ok('ordinary weekday trades', cal.sessionStatus(Date.UTC(2026, 9, 28)).status === 'TRADING');
ok('Saturday has no session', cal.sessionStatus(Date.UTC(2026, 9, 24)).status === 'WEEKEND');
const beyond = cal.sessionStatus(Date.UTC(2030, 0, 2));
ok('past VALID_THROUGH returns UNKNOWN, not a guess', beyond.status === 'UNKNOWN', beyond.status);

console.log('\n=== 2. missing candles are NOT treated as a holiday (req 7, the key rule) ===');
const now = Date.UTC(2026, 9, 28, 14, 0, 0);          // Wed 28 Oct 2026, a trading day
const noH1 = P.checkLastSession([], now);
ok('calendar says traded + no candles -> DATA GAP', !noH1.ok && /data gap, not a holiday/.test(noH1.gate), noH1.gate);
const full = await P.buildSnapshot({ engine: g.GCHLR, fetchTf: fullFetcher(now), now });
ok('a complete feed passes the session check', !/data gap/.test(String(full.analysis_blocker)), full.analysis_blocker);

console.log('\n=== 3. timestamps are Unix SECONDS (req 5) ===');
ok('a millisecond timestamp is refused', P.barOk({ time: Date.now(), open: 1, high: 2, low: 0, close: 1 }) === false);
ok('a second timestamp is accepted', P.barOk({ time: Math.floor(Date.now() / 1000), open: 1, high: 2, low: 0, close: 1 }) === true);
ok('wire series carries seconds', full.series['1m'] && full.series['1m'][0].t < 1e11);
ok('GC precision is 1 decimal', full.digits === P.GC_DIGITS && full.digits === 1);

console.log('\n=== 4. incoherent candles are refused, never repaired (req 9,10) ===');
ok('high < low refused', P.barOk({ time: 1, open: 5, high: 1, low: 9, close: 5 }) === false);
ok('close outside range refused', P.barOk({ time: 1, open: 5, high: 6, low: 4, close: 99 }) === false);
ok('NaN refused', P.barOk({ time: 1, open: NaN, high: 6, low: 4, close: 5 }) === false);
const bad = await P.buildSnapshot({ engine: g.GCHLR, now,
  fetchTf: fullFetcher(now, 'GCZ6', { '15m': { contract: 'GCZ6', bars: [{ time: 1, open: 5, high: 1, low: 9, close: 5, volume: 1 }] } }) });
ok('a malformed series withholds analysis', bad.analysis_enabled === false);
ok('and says why', /malformed|candles/.test(String(bad.analysis_blocker)), bad.analysis_blocker);

console.log('\n=== 5. disconnected / stale feeds (req 8,9,11) ===');
const down = await P.buildSnapshot({ engine: g.GCHLR, now, fetchTf: async () => { throw new Error('ECONNREFUSED'); } });
ok('total outage -> no analysis', down.analysis_enabled === false);
ok('total outage -> no candles at all', Object.keys(down.series).length === 0);
ok('total outage -> NO_DATA', down.market_status === 'NO_DATA');
ok('total outage -> zero synthetic bars', JSON.stringify(down.series) === '{}');
const stale = await P.buildSnapshot({ engine: g.GCHLR, now,
  fetchTf: fullFetcher(now - 6 * 3600e3) });   // every bar 6 h old
ok('stale feed withholds analysis', stale.analysis_enabled === false);
ok('stale feed names the staleness', /old/.test(String(stale.analysis_blocker)), stale.analysis_blocker);

console.log('\n=== 6. contract rollover (req 6) ===');
const mixed = await P.buildSnapshot({ engine: g.GCHLR, now,
  fetchTf: fullFetcher(now, 'GCZ6', { '4h': { contract: 'GCG7', bars: mkBars(now - 4 * H, 420, 4 * H) } }) });
ok('mixed contracts refuse analysis', mixed.analysis_enabled === false);
ok('and name both contracts', /GCZ6|GCG7/.test(String(mixed.analysis_blocker)), mixed.analysis_blocker);
ok('single contract is reported', full.contract && full.contract.localSymbol === 'GCZ6');

console.log('\n=== 7. insufficient history (req 9) ===');
const short = await P.buildSnapshot({ engine: g.GCHLR, now,
  fetchTf: fullFetcher(now, 'GCZ6', { '15m': { contract: 'GCZ6', bars: mkBars(now - 900e3, 20, 900e3) } }) });
ok('too few candles -> withheld', short.analysis_enabled === false);
ok('names the engine minimum', /needs 150/.test(String(short.analysis_blocker)), short.analysis_blocker);

console.log('\n=== 8. depth is display context only (req 11,12) ===');
const withDepth = await P.buildSnapshot({ engine: g.GCHLR, now, fetchTf: fullFetcher(now),
  depth: { bids: [[4000, 5]], asks: [[4001, 7]] } });
ok('depth is carried separately', !!withDepth.depth_context);
ok('depth is NOT inside series', !JSON.stringify(withDepth.series).includes('bids'));
ok('provenance marks depth display-only', /display only/.test(withDepth.provenance.depth));
ok('no depth key reaches the engine result', !JSON.stringify(withDepth.result || {}).includes('bids'));

console.log('\n=== 9. snapshot shape matches hlr-gc.js (req 3) ===');
for (const f of ['contract', 'connected', 'market_status', 'exchange_status', 'analysis_enabled',
                 'analysis_blocker', 'gates', 'last_trade_price', 'previous_close', 'series',
                 'result', 'signals', 'stats'])
  ok(`field present: ${f}`, Object.prototype.hasOwnProperty.call(full, f));
ok('gates is an array', Array.isArray(full.gates));
ok('contract exposes localSymbol', full.contract && typeof full.contract.localSymbol === 'string');

console.log('\n=== 10. GC and XAUUSD stay isolated (req 13) ===');
ok('two distinct engines', g.HLR !== g.GCHLR);
const xauBefore = JSON.stringify(g.HLR.CFG);
await P.buildSnapshot({ engine: g.GCHLR, fetchTf: fullFetcher(now), now });
ok('XAUUSD engine untouched by a GC run', JSON.stringify(g.HLR.CFG) === xauBefore);
ok('snapshot symbol is GC only', !JSON.stringify(full.result || {}).includes('XAUUSD'));

console.log('\n=== 11. read-only (req 14,15) ===');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'producer.cjs'), 'utf8');
for (const forbidden of ['/api/order', '/api/trade', '/api/position', 'alert-email', 'smtp', 'sendmail'])
  ok(`no "${forbidden}" anywhere in the producer`, !src.toLowerCase().includes(forbidden.toLowerCase()));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})();
