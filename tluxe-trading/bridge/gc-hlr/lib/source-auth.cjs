/* ============================================================================
   GC HLR -> TLUXE gateway credential (read-only GC candles).

   Once the site's owner login is on, the gateway serves GC candles to this
   producer only with its OWN credential: GC_HLR_SOURCE_TOKEN here, its SHA-256
   in the gateway's TLUXE_GC_HLR_TOKEN_SHA256. That credential opens exactly
   GET /api/databento/v1/candles/GC - nothing else on the site.

   RULES.
     * The token travels only in the Authorization header - never in a URL,
       never in a log line, never in a snapshot or an error message.
     * It is sent only over https (plain http only to a loopback test gateway),
       so a mistyped GC_HLR_SOURCE cannot leak it. A token with a non-https
       source is a configuration error and stops the service (fail closed).
     * Without a token the producer still runs: the gateway answers while the
       site is public and refuses (HTTP 401) once owner login is on, which the
       dashboard shows as OFFLINE - never as invented data.
   ========================================================================= */
'use strict';

const MIN_TOKEN = 32;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Validate once at start-up. Returns { token, problem, warning } - never the token in a message. */
function sourceAuth(env, source) {
  const token = String((env && env.GC_HLR_SOURCE_TOKEN) || '').trim();
  if (!token) {
    return { token: '', problem: null,
      warning: 'GC_HLR_SOURCE_TOKEN is not set: GC candles will be refused once the site owner login is on.' };
  }
  if (token.length < MIN_TOKEN || /\s/.test(token)) {
    return { token: '', problem: `GC_HLR_SOURCE_TOKEN must be at least ${MIN_TOKEN} characters with no spaces.`, warning: null };
  }
  let url;
  try { url = new URL(source); } catch (e) {
    return { token: '', problem: 'GC_HLR_SOURCE is not a valid URL.', warning: null };
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!secure) {
    return { token: '', problem: 'GC_HLR_SOURCE must be https:// when GC_HLR_SOURCE_TOKEN is set (the token is never sent in clear text).', warning: null };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { token: '', problem: 'GC_HLR_SOURCE must be a plain origin (no credentials, query or fragment).', warning: null };
  }
  return { token, problem: null, warning: null };
}

/** Request headers for one candle fetch. */
function sourceHeaders(auth, ua) {
  const h = { 'User-Agent': ua };
  if (auth && auth.token) h.Authorization = `Bearer ${auth.token}`;
  return h;
}

module.exports = { sourceAuth, sourceHeaders, MIN_TOKEN };
