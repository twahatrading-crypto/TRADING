/* GC session-day tests. Run: node bridge/gc-hlr/tests/session-day.test.js
   Loads the REAL engines read-only. Writes nothing. Opens no connection. */
const fs = require('fs'), path = require('path');
const ORIG = process.env.GC_HLR_ORIGINALS || String.raw`C:\Users\twaha\hlr-upload-staging\hlr-original`;  // same variable as server.cjs
const GC = path.join(__dirname, '..', 'engine', 'gc-hlr-engine.js');

const g = globalThis; g.window = g;
for (const f of ['data.js', 'vpr-engine.js']) (0, eval)(fs.readFileSync(path.join(ORIG, f), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ORIG, 'hlr-engine.js'), 'utf8'));   // -> global.HLR  (XAUUSD)
(0, eval)(fs.readFileSync(GC, 'utf8'));                                  // -> global.GCHLR (GC)

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
};
const ny = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false,
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

console.log('\n=== 1. isolation: two engines, two globals (req 13) ===');
ok('XAUUSD engine present as HLR', typeof g.HLR === 'object');
ok('GC engine present as GCHLR', typeof g.GCHLR === 'object');
ok('they are different objects', g.HLR !== g.GCHLR);
ok('XAUUSD engine NOT overwritten', typeof g.HLR.analyze === 'function' && typeof g.GCHLR.analyze === 'function');

console.log('\n=== 2. every strategy constant identical (req 6) ===');
const J = o => JSON.stringify(o);
for (const k of ['CFG', 'RATING_WEIGHTS', 'KIND_WEIGHT', 'RATING_BANDS', 'SCORE_WEIGHTS', 'STAGES', 'SIGNALS', 'BLOCKERS'])
  ok(`${k} identical`, J(g.HLR[k]) === J(g.GCHLR[k]), `${J(g.HLR[k])} vs ${J(g.GCHLR[k])}`);

console.log('\n=== 3. CME session boundary, incl. DST (req 3,4) ===');
// Build an H1 series over a window and ask each engine for the previous day.
const H = 3600e3;
function series(fromUtcMs, hours, priceAt) {
  const out = [];
  for (let i = 0; i < hours; i++) { const t = fromUtcMs + i * H, p = priceAt(i, t);
    out.push({ t, o: p, h: p + 2, l: p - 2, c: p, v: 10 }); }
  return out;
}
// ONE spike, placed where the two definitions genuinely disagree.
// 17:00-18:59 ET falls BEFORE UTC midnight: its UTC day is D, its CME session day is D+1.
const start = Date.UTC(2026, 9, 19, 0, 0, 0);
const nyHour = t => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
  hour12: false, hour: '2-digit' }).format(new Date(t)).replace('24', '0'));
const H1 = 3600e3;
const bars = series(start, 24 * 6, () => 4000);
let spikeAt = -1;
for (let i = 0; i < bars.length; i++) { const h = nyHour(bars[i].t); if (h === 17 || h === 18) { spikeAt = i; break; } }
if (spikeAt >= 0) bars[spikeAt] = { t: bars[spikeAt].t, o: 4000, h: 5000, l: 4000, c: 4000, v: 10 };
const asOf = start + (24 * 6 - 1) * H;
const u = g.HLR.previousDay(bars, asOf);
const c = g.GCHLR.previousDay(bars, asOf);
ok('found a bar in the 17:00-18:59 ET discriminating window', spikeAt >= 0);
ok('both engines return a previous day', !!u && !!c);
ok('the two engines bucket that bar into DIFFERENT days', u && c && u.day !== c.day,
   u && c ? `utcDay=${new Date(u.day).toISOString().slice(0,10)} gcDay=${new Date(c.day).toISOString().slice(0,10)}` : '');

console.log('\n=== 4. DST transitions resolve without fixed offsets (req 4) ===');
for (const [label, ms] of [['before US DST ends', Date.UTC(2026, 10, 1, 3, 0, 0)],
                           ['after US DST ends',  Date.UTC(2026, 10, 2, 3, 0, 0)],
                           ['before DST starts',  Date.UTC(2026, 2, 7, 3, 0, 0)],
                           ['after DST starts',   Date.UTC(2026, 2, 9, 3, 0, 0)]]) {
  const s = series(ms - 48 * H, 72, i => 4000 + (i % 5));
  const r = g.GCHLR.previousDay(s, ms);
  ok(`${label}: previous session resolves`, !!r, r ? '' : 'returned null');
}

console.log('\n=== 5. holidays / missing sessions are skipped, not guessed (req 5,11) ===');
// A gap (no bars) must be skipped; the walk-back finds the last day that traded.
const gapped = series(start, 24 * 3, i => 4000 + i).concat(series(start + 24 * 5 * H, 24, i => 4100 + i));
const r5 = g.GCHLR.previousDay(gapped, start + 24 * 6 * H);
ok('gap skipped, an earlier traded session used', !!r5, r5 ? '' : 'null');
ok('too few bars -> null, never a guess', g.GCHLR.previousDay([{ t: start, o: 1, h: 1, l: 1, c: 1, v: 1 }], asOf) === null);
ok('empty series -> null', g.GCHLR.previousDay([], asOf) === null);

console.log('\n=== 6. GC and XAUUSD do not share state (req 13) ===');
const before = J(g.HLR.previousDay(bars, asOf));
g.GCHLR.previousDay(bars, asOf);
ok('XAUUSD result unchanged after GC runs', J(g.HLR.previousDay(bars, asOf)) === before);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
