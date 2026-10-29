"""The copied original HLR dashboard: served only to a signed-in owner, byte-for-byte.

WHY A GATE AT ALL. The dashboard ships its own strategy to the browser - `hlr.html` loads
`hlr-engine.js` with a plain <script src>, and that file is unminified, commented source. Anyone who
can fetch it can read the strategy. Protecting it is therefore an authorization problem, not a
"don't publish the URL" problem: EVERY file under /hlr-original/ is protected, not just the document.

FAIL CLOSED. The gate is the ordinary owner session. When no owner password is configured there is no
way to obtain a session, so the dashboard is unreachable by everyone - including the owner - rather
than quietly public. That is deliberate.

NOT UNDER THE STATIC ROOT. The files live in a PRIVATE directory (`TLUXE_HLR_FILES_DIR`, a Railway
volume at /app/private/hlr-original) that is deliberately outside TLUXE_STATIC_DIR. The public static
handler therefore cannot reach the strategy even in principle - not by a `..` path, not by a mistake
in a future edit. `is_protected` remains as a second line of defence: if anything ever lands under
the static root at /hlr-original, the SPA handler refuses that subtree too.

NO CACHING. Protected assets are `no-store, private` and vary on Cookie, so no shared cache - a
browser cache, a proxy, or Cloudflare - can keep a copy that outlives the session.

FRAMING. The dashboard is embedded in the TLUXE app in a same-origin iframe, while the site-wide
headers forbid framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). The entry document - and
only it - sets its own two headers. The security middleware uses setdefault(), so every other route on
the site keeps DENY / 'none'.

The files themselves are never modified: they are read from disk and sent exactly as copied.
"""
from __future__ import annotations

import os
from pathlib import Path

from aiohttp import web

#: Directory holding the copy, relative to the static root. The whole subtree is protected.
HLR_DIR = "hlr-original"
#: The dashboard's entry document.
HLR_DOC = "hlr.html"
HLR_DOC_PATH = f"{HLR_DIR}/{HLR_DOC}"

#: As the site-wide policy, except `frame-ancestors 'self'`: these documents may be framed, and only
#: by this origin. `connect-src 'self'` is what keeps the dashboard inside the gateway.
HLR_CSP = (
    "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; "
    "style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; "
    "media-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
)


#: Virtual file: not part of the copy, served from this module at /hlr-original/_tluxe-shim.js.
SHIM_NAME = "_tluxe-shim.js"

#: The dashboard's files hard-code the loopback addresses of the services on the trading PC
#: (hlr-winloss.js:35 and hlr-gc.js:37 hold them in closure constants with no same-origin fallback),
#: and feed.js asks this origin for /api/... which here belongs to the TLUXE gateway. Those files may
#: not be edited, so the URL is rewritten in the browser BEFORE the request is made.
#:
#: What it does: swaps a URL prefix. That is all.
#: What it never does: read, buffer, parse or alter a response body, status or header; touch HLR,
#: HLRUI, HLRGC, HLRRENDER, HLRALERT or HLRLOG; cache, retry, time or log anything. The relay is a
#: pass-through, so the JSON the engine parses is the same JSON the local engine returns, and the
#: analysis is therefore identical. The shim never sees strategy data at all.
SHIM_JS = """/* TLUXE: routes the original dashboard's hard-coded loopback URLs to this origin.
   Rewrites the request URL only - never a response, never engine state. */
(function () {
  var PREFIX = '/api/hlr';
  var MAP = [
    ['http://127.0.0.1:8261', PREFIX + '/gc'],       /* GC HLR engine      */
    ['http://127.0.0.1:8127', PREFIX + '/tracker'],  /* Win/Loss tracker   */
    ['http://127.0.0.1:8124', PREFIX + '/mt5'],      /* feed.js fallback   */
    ['http://127.0.0.1:8123', PREFIX + '/mt5']       /* MT5 bridge         */
  ];
  function route(url) {
    if (typeof url !== 'string') return url;
    if (url.indexOf(PREFIX + '/') === 0) return url;          /* already routed */
    for (var i = 0; i < MAP.length; i++) {
      if (url.indexOf(MAP[i][0]) === 0) return MAP[i][1] + url.slice(MAP[i][0].length);
    }
    if (url.indexOf('/api/') === 0) return PREFIX + '/mt5' + url;  /* feed.js, same origin */
    return url;
  }
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    return origFetch.call(this, typeof input === 'string' ? route(input) : input, init);
  };
  var origOpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
  if (origOpen) {
    window.XMLHttpRequest.prototype.open = function (method, url) {
      arguments[1] = route(url);
      return origOpen.apply(this, arguments);
    };
  }

  /* ---- Opens this page on XAUUSD -------------------------------------------------------------
     A SEPARATE CONCERN from the URL routing above, and deliberately narrow.

     The dashboard ships with DEFAULT_MARKET = 'GC' (hlr-gc.js), so a few seconds after load it
     switches itself to GC. On the trading PC that is what the owner wants. This is the XAUUSD MT5
     page, so it opens on XAUUSD instead.

     It does that ONLY through the dashboard's own public control - HLRGC.switchTo - which is
     exactly what clicking the selector calls, and which saves and restores state symmetrically.
     No file is modified, no strategy code is re-implemented, no analysis is recomputed and no
     market data is touched. GC is not disabled: the GC button still works, and the moment the
     viewer touches the selector this stops interfering for good.

     It keeps trying for SETTLE_MS because the dashboard's own GC switch waits for the MT5 side to
     settle (up to 15 s), so the correction must outlive that window - but not forever. */
  var WANT = 'XAUUSD', SETTLE_MS = 25000, t0 = Date.now(), userChose = false;
  document.addEventListener('pointerdown', function (e) {
    if (e.target && e.target.closest && e.target.closest('#hMkt')) userChose = true;
  }, true);
  (function hold() {
    if (userChose || Date.now() - t0 > SETTLE_MS) return;
    var g = window.HLRGC;
    if (g && typeof g.switchTo === 'function' && typeof g.market === 'function' && g.market() !== WANT) {
      try { g.switchTo(WANT); } catch (e) { /* the dashboard owns this; never break it */ }
    }
    setTimeout(hold, 120);
  })();

  /* ---- Real MT5 data, or nothing -------------------------------------------------------------
     THE RULE THIS ENFORCES: the cloud copy must never draw a candle it did not get from MT5.

     The dashboard ships a synthetic generator (data.js) and falls back to it whenever its bridge
     is unreachable - feed.js sets provider='demo' in init() and refreshStatus(), and every
     consumer then branches on `provider !== 'mt5'`. On the owner's PC that fallback is a
     convenience. Served from the cloud it would be a lie: invented prices on a page that looks
     live. Worse, it is silent - the page keeps rendering and only a small label changes.

     WHY THE GENERATOR, NOT THE BRANCHES. Wrapping feed.js's call sites would mean finding every
     one of them and trusting that no future path appears. Instead this empties the generator
     itself, which is the single place fake candles can come from. Any caller - known, unknown or
     added later - gets nothing, so the dashboard falls through to the WAITING FOR DATA / DATA
     SOURCE UNKNOWN state it already renders natively when a feed returns nothing.

     WHAT IS DELIBERATELY LEFT ALONE. MKT also carries fmt / sma / ema / bollinger / rsi, which the
     UI uses to FORMAT real numbers. Emptying those would break the live display. Only the data
     PRODUCERS are emptied: MKT.generate, SYNTH.history, SYNTH.tick. SYNTH.isSynthetic and
     SYNTH.meta stay, because the symbol plumbing calls them on real symbols too.

     STALE AND DISCONNECTED ARE THE SAME PATH. The relay closes a stale link itself, and answers
     an offline link with an error rather than a cached body, so both end as a failed probe - and
     a failed probe now yields no candles instead of invented ones.

     No file among the 76 is modified. This runs after they load and empties three functions. */
  (function noSynthetic() {
    var EMPTY_BARS = [];
    function emptied(obj, name, value) {
      if (!obj || typeof obj[name] !== 'function') return false;
      try {
        obj[name] = function () { return typeof value === 'function' ? value() : value; };
        return true;
      } catch (e) { return false; }   /* frozen object: report it, never throw */
    }
    function apply() {
      var done = 0;
      if (window.MKT)   done += emptied(window.MKT, 'generate', function () { return EMPTY_BARS.slice(); });
      if (window.SYNTH) {
        done += emptied(window.SYNTH, 'history', function () { return EMPTY_BARS.slice(); });
        done += emptied(window.SYNTH, 'tick', null);
        done += emptied(window.SYNTH, 'list', function () { return []; });
      }
      return done;
    }
    apply();
    /* The scripts load after this one, so re-apply until they exist. Bounded, not forever. */
    var tries = 0;
    (function retry() {
      if (++tries > 100) return;              /* ~12 s, then stop */
      apply();
      label();                                 /* FEED appears on the same schedule */
      setTimeout(retry, 120);
    })();
    /* A visible, honest label when the feed is not MT5. The dashboard shows 'Demo data' there by
       default, which would be wrong twice over: there is no demo data any more, and the viewer
       needs to know the feed is DOWN. The global is FEED (feed.js: `global.FEED = {...}`). */
    var wrapped = false;
    function label() {
      if (wrapped) return true;
      var F = window.FEED;
      if (!F || typeof F.sourceLabel !== 'function') return false;
      try {
        var orig = F.sourceLabel;
        F.sourceLabel = function () {
          try {
            return F.provider === 'mt5' ? orig.apply(this, arguments) : 'OFFLINE - DATA UNAVAILABLE';
          } catch (e) { return 'OFFLINE - DATA UNAVAILABLE'; }
        };
        wrapped = true;
      } catch (e) { /* never break the dashboard over a label */ }
      return wrapped;
    }
    label();
  })();

  /* ---- GC: name the source that actually supplied the candles ---------------------------------
     THE PROBLEM. hlr-gc.js was written when IBKR was the intended GC source, and its connection
     badge says so in plain text:

         if (s.analysis_enabled) return ['live', 'IBKR CONNECTED'];     // hlr-gc.js:207

     GC candles now come from DATABENTO; IBKR supplies depth and nothing else. So the badge credits
     the wrong vendor for the data on screen, and it would keep saying IBKR CONNECTED while IBKR was
     down - the one moment the label matters.

     WHY THIS IS DONE IN THE DOM. connLabel is a private function inside hlr-gc.js's closure and the
     string is not data-driven, so no snapshot value can reach it. HLRGC exposes only market,
     switchTo, snapshot, generation and BASE. The badge text is therefore corrected where it lands,
     in #hConnText, from the snapshot's OWN provenance - which is the authority on where the candles
     came from.

     WHAT THIS DOES NOT TOUCH. Only the connection badge, and only while the market is GC. XAUUSD
     passes through untouched. No strategy, analysis, signal, score, entry, stop or target is read
     or altered - this reads a status string and writes a status string. No file is modified. */
  (function gcSourceLabel() {
    var EL = 'hConnText';
    function snapshot() {
      try { return (window.HLRGC && window.HLRGC.snapshot && window.HLRGC.snapshot()) || null; }
      catch (e) { return null; }
    }
    function isGc() {
      try { return !!(window.HLRGC && window.HLRGC.market && window.HLRGC.market() === 'GC'); }
      catch (e) { return false; }
    }
    /* The honest label, derived only from what the snapshot reports about itself. Nothing is
       assumed: no snapshot means OFFLINE, not "probably still fine". */
    function truth() {
      var s = snapshot();
      if (!s) return 'DATABENTO OFFLINE';
      if (!s.connected) return 'DATABENTO OFFLINE';
      var candles = (s.provenance && s.provenance.candles) || '';
      var vendor = /databento/i.test(candles) ? 'DATABENTO'
                 : candles ? candles.split(':')[0].toUpperCase() : 'SOURCE';
      var base;
      if (s.analysis_enabled && s.market_status === 'LIVE') base = vendor + ' LIVE';
      else if (s.market_status === 'STALE') base = vendor + ' STALE';
      else if (s.market_status === 'OFFLINE' || s.market_status === 'NO_DATA') base = vendor + ' OFFLINE';
      else base = vendor + ' - ANALYSIS GATED';
      /* IBKR is mentioned ONLY for depth, and only when the depth feed itself says it is fresh.
         Its health is verified separately from the candle feed, because the two fail apart. */
      var d = s.depth_context;
      if (d && d.fresh === true) base += ' · IBKR DEPTH LIVE';
      else if (d) base += ' · IBKR DEPTH STALE';
      return base;
    }
    var last = null;
    function apply() {
      if (!isGc()) { last = null; return; }        /* XAUUSD is never touched */
      var el = document.getElementById(EL);
      if (!el) return;
      var want = truth();
      if (el.textContent !== want) { el.textContent = want; }
      last = want;
    }
    /* The dashboard repaints the badge on its own schedule, so watch the node and re-assert after
       it writes. An observer costs nothing while nothing changes. */
    function watch() {
      var el = document.getElementById(EL);
      if (!el) return false;
      try {
        new MutationObserver(function () { apply(); })
          .observe(el, { childList: true, characterData: true, subtree: true });
        return true;
      } catch (e) { return false; }
    }
    var tries = 0;
    (function hold() {
      if (++tries > 200) return;                   /* ~24 s, then stop trying to attach */
      if (!watch()) { setTimeout(hold, 120); return; }
      apply();
      setInterval(apply, 2000);                    /* belt: covers a full re-render of the node */
    })();
  })();
})();
"""

#: Injected into the SERVED hlr.html only. The file on disk is never modified: its SHA-256 still
#: matches the original, and only the bytes on the wire carry this one extra line.
SHIM_TAG = b'<script src="_tluxe-shim.js"></script>'

def protected_root(root: Path) -> Path:
    return (root / HLR_DIR).resolve()


def is_protected(root: Path, target: Path) -> bool:
    """True if `target` lands inside the protected subtree - however the URL spelled it.

    Compares RESOLVED paths, so `..` segments, symlinks and (on Windows) a different letter case all
    reach the same answer. Anything that cannot be resolved counts as protected: an unreadable path is
    never a reason to serve a file without a session.
    """
    guarded = protected_root(root)
    try:
        resolved = Path(target).resolve()
    except (OSError, ValueError):
        return True
    return resolved == guarded or guarded in resolved.parents


def inject_shim(html: bytes) -> bytes:
    """Put the shim <script> before the dashboard's own first script, so it patches fetch first."""
    if SHIM_TAG in html:
        return html
    at = html.find(b"<script")
    if at < 0:
        return html
    return html[:at] + SHIM_TAG + b"\n" + html[at:]


def files_status(files_dir: Path) -> dict:
    """Is the private directory present, and what can THIS process actually do with it?

    A Railway volume is mounted over the image's directory at runtime, so the Dockerfile's build-time
    `chown` does NOT decide the mount's ownership - the platform does. Whether uid 10001 can read it
    (and whether an upload could write it) is therefore a question to OBSERVE, not to assume. This
    reports exactly that, plus the raw owner and mode so a permission problem is diagnosable in one
    request. It never lists a file name and never reads a file's contents.
    """
    d = Path(files_dir)
    out = {"exists": False, "readable": False, "writable": False, "files": 0, "entry": False,
           "uid": None, "gid": None, "mode": None, "processUid": None}
    try:
        out["processUid"] = os.getuid()  # type: ignore[attr-defined]
    except AttributeError:
        pass  # Windows, in local tests
    try:
        if not d.is_dir():
            return out
        out["exists"] = True
        st = d.stat()
        out["uid"], out["gid"] = getattr(st, "st_uid", None), getattr(st, "st_gid", None)
        out["mode"] = oct(st.st_mode & 0o777)
        out["readable"] = os.access(d, os.R_OK | os.X_OK)
        out["writable"] = os.access(d, os.W_OK)
        if not out["readable"]:
            return out
        names = [f.name for f in d.iterdir() if f.is_file()]
        entry = d / HLR_DOC
        out["files"] = len(names)
        out["entry"] = entry.is_file() and os.access(entry, os.R_OK)
        return out
    except PermissionError:
        out["exists"] = True
        return out
    except OSError:
        return out


def _frameable(resp: web.StreamResponse) -> bool:
    """Only what the browser may actually try to RENDER in the frame needs the relaxation:

      * an HTML document - the dashboard's own pages, which the frame navigates between;
      * any error - a 401 or 404 that would otherwise be blocked, leaving a blank frame and no
        explanation for the viewer.

    A script or stylesheet is never framed, so it keeps the site-wide `DENY`. Narrower is better.
    """
    if resp.status >= 400:
        return True
    ctype = (resp.headers.get("Content-Type") or "").lower()
    return ctype.startswith("text/html")


def _frame_headers(resp: web.StreamResponse) -> web.StreamResponse:
    """Stamp this route's framing and caching headers on a response.

    EVERY response from the HLR route needs these - 200, 401 and 404 alike. The site-wide middleware
    applies `X-Frame-Options: DENY` and `frame-ancestors 'none'` by setdefault, so a response that
    skips this (an auth failure, a missing file) is refused by the browser inside the iframe with
    ERR_BLOCKED_BY_RESPONSE, and the viewer sees a blank frame instead of the reason. Setting them
    here means the error is at least *displayable* - it does not weaken anything: the policy is still
    `frame-ancestors 'self'`, scoped to this route, and the response itself is still a 401 or 404.
    """
    if _frameable(resp):
        resp.headers["X-Frame-Options"] = "SAMEORIGIN"
        resp.headers["Content-Security-Policy"] = HLR_CSP
    resp.headers["Cache-Control"] = "no-store, private, max-age=0"
    resp.headers["Vary"] = "Cookie"
    return resp


def hlr_assets(files_dir: Path, require_session):
    """Build the gated handler for everything under /hlr-original/.

    `files_dir` is the PRIVATE directory the dashboard was uploaded to - never the public static
    root. `require_session` is passed in rather than imported, so this module stays independent of
    app.py (which imports it) and the session behaviour - rotation, TTL, audit - stays in one place.
    """
    guarded = Path(files_dir).resolve()

    @require_session
    async def serve(request: web.Request) -> web.StreamResponse:
        rel = request.match_info.get("tail", "")
        if rel == SHIM_NAME:
            # Always available. It does two things: route the dashboard's hard-coded loopback URLs
            # to this origin, and open the page on XAUUSD. The second must work even when the data
            # relay is not configured, so neither is gated on it. With no relay the rewritten URLs
            # simply 404 here instead of failing against 127.0.0.1 - the same outcome, stated more
            # honestly, and the dashboard reports itself offline either way.
            resp = web.Response(text=SHIM_JS, content_type="application/javascript", charset="utf-8")
            resp.headers["Cache-Control"] = "no-store, private, max-age=0"
            resp.headers["Vary"] = "Cookie"
            return resp
        try:
            target = (guarded / rel).resolve()
        except (OSError, ValueError):
            raise web.HTTPNotFound(text="Not found.")
        # Re-check containment AFTER resolution: `rel` may contain `..` segments.
        if not rel or not target.is_file() or not (target == guarded or guarded in target.parents):
            # Distinguish "the dashboard has not been uploaded" from "no such file", because the
            # first is an expected operational state and the second is a mistake. Neither reveals
            # anything: the caller already holds a valid session to get this far.
            if not (guarded / HLR_DOC).is_file():
                raise web.HTTPNotFound(
                    text="The HLR dashboard files have not been uploaded to this deployment yet.")
            raise web.HTTPNotFound(text="Not found.")

        if target.suffix.lower() == ".html":
            # EVERY document of the dashboard, not just hlr.html. It is a multi-page app: its tabs and
            # icon rail are ordinary relative links to index.html (Chart Workspace), vpr.html (Volume
            # Profile) and sweep.html (Sweep Engulfing). If any of them kept the site-wide
            # `X-Frame-Options: DENY`, the browser would refuse that navigation and the frame would go
            # blank and opaque - which is exactly what happened before this was widened.
            #
            # These are the only responses not sent straight from disk: with the relay built, one
            # <script> tag is added so the dashboard's hard-coded loopback URLs reach this origin.
            # The files themselves are untouched - compare their SHA-256 with the originals any time.
            body = inject_shim(target.read_bytes())
            return web.Response(body=body, content_type="text/html", charset="utf-8")
        return web.FileResponse(target)

    async def handler(request: web.Request) -> web.StreamResponse:
        """Wraps the gated handler so that EVERY outcome carries this route's framing headers.

        Without this, a 401 (no session) or a 404 (volume not uploaded yet) leaves the middleware's
        site-wide `X-Frame-Options: DENY` in place, and the browser blocks the response inside the
        iframe with ERR_BLOCKED_BY_RESPONSE - the viewer sees a blank frame and no explanation. The
        status codes are unchanged; only the headers that decide whether the answer can be *shown*.

        The failure is turned into an ordinary Response rather than re-raised, for two reasons.
        Re-raising loses the fix: the site-wide middleware catches HTTPException and rebuilds it
        with `_err(...)`, which drops these headers and the browser blocks the frame again. And
        aiohttp deprecated *returning* an HTTPException object (#2415) - it still works, but it
        warns and is slated for removal. Copying it into a real Response avoids both.
        """
        try:
            return _frame_headers(await serve(request))
        except web.HTTPException as exc:
            return _frame_headers(web.Response(
                status=exc.status, reason=exc.reason, text=exc.text,
                content_type=exc.content_type or "text/plain"))

    return handler
