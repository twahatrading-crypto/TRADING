/* End-to-end: real Databento GC -> producer -> snapshot. Read-only, writes nothing.
   node bridge/gc-hlr/tests/live-path.cjs */
'use strict';
const fs = require('fs'), path = require('path');
const P = require('../lib/producer.cjs');

const ORIG = String.raw`C:\Users\twaha\hlr-upload-staging\hlr-original`;
const g = globalThis; g.window = g;
for (const f of ['data.js', 'vpr-engine.js']) (0, eval)(fs.readFileSync(path.join(ORIG, f), 'utf8'));
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'engine', 'gc-hlr-engine.js'), 'utf8'));

const BASE = process.env.TLUXE_GC_SOURCE || 'https://twahatrading.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function fetchTf(tf) {
  const url = `${BASE}/api/databento/v1/candles/GC?timeframe=${P.DB_TF[tf]}&limit=400`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

(async () => {
  const now = Date.now();
  const snap = await P.buildSnapshot({ engine: g.GCHLR, fetchTf, now });

  console.log('\n=== LIVE PATH: Databento -> producer -> snapshot ===');
  console.log('  contract          :', snap.contract && snap.contract.localSymbol);
  console.log('  connected         :', snap.connected);
  console.log('  market_status     :', snap.market_status);
  console.log('  analysis_enabled  :', snap.analysis_enabled);
  console.log('  analysis_blocker  :', snap.analysis_blocker);
  console.log('  gates             :', snap.gates.length ? snap.gates : '(none)');
  console.log('  last_trade_price  :', snap.last_trade_price);
  console.log('  previous_close    :', snap.previous_close);
  console.log('  digits / tick     :', snap.digits, '/', snap.tick);
  console.log('  series bars       :', Object.fromEntries(Object.entries(snap.series).map(([k, v]) => [k, v.length])));
  const t = snap.series['1m'] && snap.series['1m'].slice(-1)[0];
  if (t) console.log('  newest M1 (wire)  :', JSON.stringify(t), '-> seconds?', t.t < 1e11);

  if (snap.result) {
    const r = snap.result;
    console.log('\n  --- engine result (GCHLR) ---');
    console.log('  symbol            :', r.symbol);
    console.log('  signal            :', r.signal, '/', r.signalLabel);
    console.log('  price             :', r.price);
    console.log('  levels            :', (r.levels || []).length);
    const pd = (r.levels || []).filter(l => l.key === 'pdh' || l.key === 'pdl')
                               .map(l => `${l.key}=${l.price}`);
    console.log('  PDH/PDL (CME day) :', pd.join('  ') || '(none)');
    console.log('  score             :', r.score && r.score.total);
  }
  console.log('\n  provenance        :', JSON.stringify(snap.provenance, null, 2).replace(/\n/g, '\n                      '));
  console.log();
})().catch(e => { console.error('  live path failed:', e.message); process.exit(1); });
