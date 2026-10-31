/* ============================================================================
   GC HLR service - the producer `hlr-gc.js` polls.

       GET /api/snapshot    the snapshot contract (the only route the dashboard uses)
       GET /api/health      liveness + link state, for operators
       GET /api/calendar    what the CME calendar believes, for auditing

   BINDS TO 127.0.0.1 ONLY. The dashboard reaches it over loopback and the cloud
   reaches it through the existing authenticated hlr-link relay, which allows
   exactly `^/api/snapshot`. Nothing here is ever exposed publicly, and the bind
   address is refused if it is not loopback - a misconfiguration should stop the
   service, not quietly publish it.

   WHAT IT WILL NOT DO. No order path. No e-mail path. No IBKR connection. No
   write of any kind: every handler is GET and the process never mutates
   anything outside its own memory.

   FRESHNESS AND STATUS. The service keeps the last good snapshot ONLY to report
   how old it is - it never serves it as if it were current. A caller always
   learns the true state:

       LIVE     data arrived, passed validation, analysis ran
       STALE    data arrived but is older than this timeframe allows
       OFFLINE  the source could not be reached, or validation refused it

   RECONNECT. A failed poll schedules the next attempt with exponential backoff
   and jitter, capped, retrying indefinitely. It never restarts anything else
   and never touches another service.
   ========================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const P = require('./lib/producer.cjs');
const cal = require('./lib/cme-calendar.cjs');
const { sourceAuth, sourceHeaders } = require('./lib/source-auth.cjs');

// ---- configuration (environment only; no secret is read or logged) ---------
const PORT = Number(process.env.GC_HLR_PORT || 8261);
const HOST = process.env.GC_HLR_HOST || '127.0.0.1';
const SOURCE = process.env.GC_HLR_SOURCE || 'https://twahatrading.com';
const POLL_MS = Number(process.env.GC_HLR_POLL_MS || 15000);
const BACKOFF_MIN = 1000, BACKOFF_MAX = 60000;
const UA = 'TLUXE-GC-HLR/1.0';

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
  console.error(`refusing to bind ${HOST}: this service is loopback-only`);
  process.exit(2);
}

// Read-only GC candle credential for the gateway (see lib/source-auth.cjs). Checked
// once; a bad configuration stops the service rather than leaking or guessing.
const AUTH = sourceAuth(process.env, SOURCE);
if (AUTH.problem) {
  console.error(`refusing to start: ${AUTH.problem}`);
  process.exit(2);
}
if (AUTH.warning) console.warn(AUTH.warning);

// ---- load the engines, read-only ------------------------------------------
const g = globalThis;
g.window = g;
const ORIG = process.env.GC_HLR_ORIGINALS || String.raw`C:\Users\twaha\hlr-upload-staging\hlr-original`;
for (const f of ['data.js', 'vpr-engine.js']) {
  (0, eval)(fs.readFileSync(path.join(ORIG, f), 'utf8'));
}
(0, eval)(fs.readFileSync(path.join(__dirname, 'engine', 'gc-hlr-engine.js'), 'utf8'));
if (typeof g.GCHLR !== 'object') { console.error('GCHLR engine failed to load'); process.exit(3); }
/* The synthetic generator came in with data.js (it supplies tfMs/TFS too). Empty
   it here so this process cannot produce a fabricated candle even by accident. */
if (g.MKT && typeof g.MKT.generate === 'function') g.MKT.generate = () => [];

// ---- state ----------------------------------------------------------------
const state = {
  snapshot: null,          // last snapshot built, good or not
  lastGoodAt: null,        // when analysis last ran cleanly
  lastAttemptAt: null,
  consecutiveFailures: 0,
  backoffMs: BACKOFF_MIN,
  sourceReachable: false,
  pollTimer: null,
};

async function fetchTf(tf) {
  const url = `${SOURCE}/api/databento/v1/candles/GC?timeframe=${P.DB_TF[tf]}&limit=400`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: sourceHeaders(AUTH, UA), signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/** One poll. Never throws; failure is recorded, never rendered as data. */
async function poll() {
  state.lastAttemptAt = Date.now();
  let snap;
  try {
    snap = await P.buildSnapshot({ engine: g.GCHLR, fetchTf, now: Date.now() });
    state.sourceReachable = !!snap.connected;
  } catch (e) {
    /* An unexpected failure must still produce an honest snapshot, not a gap in
       the record. The dashboard needs to be told OFFLINE, not left with the
       previous answer. */
    snap = {
      contract: null, connected: false, market_status: 'OFFLINE',
      exchange_status: 'COMEX', analysis_enabled: false,
      analysis_blocker: 'GC data source unreachable.',
      gates: [`producer: ${String(e.message || e).slice(0, 100)}`],
      last_trade_price: null, previous_close: null,
      series: {}, result: null, signals: [], stats: {},
      provenance: { candles: 'unavailable', analysis: 'withheld',
                    depth: 'none', calendar: `cme-calendar valid through ${cal.VALID_THROUGH}` },
      digits: P.GC_DIGITS, tick: P.GC_TICK, generated_at: Math.floor(Date.now() / 1000),
    };
    state.sourceReachable = false;
  }

  if (snap.analysis_enabled) {
    state.lastGoodAt = Date.now();
    state.consecutiveFailures = 0;
    state.backoffMs = BACKOFF_MIN;
  } else {
    state.consecutiveFailures++;
    /* exponential, jittered, capped - and it only governs OUR retry rate.
       Nothing is restarted and no other service is touched. */
    const grown = Math.min(state.backoffMs * 2, BACKOFF_MAX);
    state.backoffMs = Math.round(grown * (0.8 + Math.random() * 0.4));
  }

  /* `market_status` describes THIS snapshot. The previous one is never promoted
     to stand in for it: a stale body served as live would be a lie. */
  if (!snap.connected) snap.market_status = 'OFFLINE';
  else if (!snap.analysis_enabled) snap.market_status = 'STALE';

  snap.service = {
    lastGoodAgeSec: state.lastGoodAt ? Math.round((Date.now() - state.lastGoodAt) / 1000) : null,
    consecutiveFailures: state.consecutiveFailures,
    nextAttemptInMs: snap.analysis_enabled ? POLL_MS : state.backoffMs,
  };
  state.snapshot = snap;

  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(poll, snap.analysis_enabled ? POLL_MS : state.backoffMs);
}

// ---- HTTP, GET only -------------------------------------------------------
/* CORS, LOOPBACK ONLY.

   The dashboard is served by the MT5 bridge on 127.0.0.1:8123 and fetches this
   service on 127.0.0.1:8261. Different port means different origin, so without
   an Access-Control-Allow-Origin header the browser blocks every request and
   the dashboard reports "the GC engine is not reachable" while the service sits
   there answering 200 to curl. No unit test can see this - it only appears when
   a real browser makes the call.

   WHY NOT "ANY LOOPBACK ORIGIN". An earlier version echoed back any
   127.0.0.1/localhost Origin. That is too generous, for two reasons:

     - every other page on this machine becomes trusted. Any local dev server,
       any Electron app, any tool that happens to be serving on some port could
       read this market data at will.
     - a public hostname can be made to resolve to 127.0.0.1 (DNS rebinding).
       The Origin header would then still read as that public site, which this
       rule rejects - but the loose version's intent was wrong in principle, and
       it is better not to rely on one accident of the header for safety.

   So the allowance is an explicit PORT allowlist, not "anything on loopback".
   Only the origins that actually serve the HLR dashboard are permitted, and the
   list is overridable for anyone running it elsewhere. Everything else gets no
   header and the browser blocks it. */
const DEFAULT_ALLOWED = ['http://127.0.0.1:8123', 'http://localhost:8123',
                         'http://127.0.0.1:8124', 'http://localhost:8124'];
const ALLOWED_ORIGINS = new Set(
  (process.env.GC_HLR_ALLOWED_ORIGINS || DEFAULT_ALLOWED.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean)
);
const originAllowed = (o) => !!o && ALLOWED_ORIGINS.has(o);

const send = (res, code, body, origin) => {
  const text = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(text),
  };
  if (originAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(code, headers);
  res.end(text);
};

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    /* Preflight. GET only, and only from loopback. */
    const h = { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600', 'Vary': 'Origin' };
    if (originAllowed(origin)) h['Access-Control-Allow-Origin'] = origin;
    res.writeHead(204, h);
    return res.end();
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' }, origin);
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === '/api/snapshot') {
    if (!state.snapshot) {
      return send(res, 200, {
        contract: null, connected: false, market_status: 'OFFLINE',
        analysis_enabled: false, analysis_blocker: 'Starting up - no data yet.',
        gates: ['service: first poll has not completed'],
        series: {}, result: null, signals: [], stats: {},
        digits: P.GC_DIGITS, tick: P.GC_TICK,
      }, origin);
    }
    return send(res, 200, state.snapshot, origin);
  }

  if (url.pathname === '/api/health') {
    return send(res, 200, {
      ok: true, service: 'gc-hlr', bind: `${HOST}:${PORT}`,
      sourceReachable: state.sourceReachable,
      lastAttemptAgeSec: state.lastAttemptAt ? Math.round((Date.now() - state.lastAttemptAt) / 1000) : null,
      lastGoodAgeSec: state.lastGoodAt ? Math.round((Date.now() - state.lastGoodAt) / 1000) : null,
      consecutiveFailures: state.consecutiveFailures,
      backoffMs: state.backoffMs,
      marketStatus: state.snapshot ? state.snapshot.market_status : 'OFFLINE',
    }, origin);
  }

  if (url.pathname === '/api/calendar') {
    const key = cal.sessionDayKey(Date.now());
    const days = [];
    for (let i = 0; i < 7; i++) {
      const k = key - i * cal.DAY;
      days.push(Object.assign({ key: cal.keyToIso(k) }, cal.sessionStatus(k)));
    }
    return send(res, 200, { validThrough: cal.VALID_THROUGH, today: cal.keyToIso(key), days }, origin);
  }

  return send(res, 404, { error: 'not found' }, origin);
});

server.listen(PORT, HOST, () => {
  console.log(`gc-hlr listening on http://${HOST}:${PORT} (loopback only)`);
  console.log(`source: ${SOURCE}  poll: ${POLL_MS}ms  calendar valid through ${cal.VALID_THROUGH}`);
  poll();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { clearTimeout(state.pollTimer); server.close(() => process.exit(0)); });
}

module.exports = { server, state, poll };
