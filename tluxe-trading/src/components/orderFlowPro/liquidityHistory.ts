import { HEAT_BUCKET_MS } from '../../engines/orderFlowPro/config';
import type { RecordedSeed } from '../../engines/orderFlowPro/liquidityClass';
import type { OfpRoot } from '../../engines/orderFlowPro/types';
import { parseHeatmap } from '../../providers/orderFlowPro/gatewayMap';

/* ============================================================================
 * Recorded IBKR depth for the liquidity classes: ONE read-only GET of the gateway's existing /api/ibkr/heatmap per
 * instrument and contract per page session (never polled, never retried in a loop). It only seeds the reference
 * distribution so classes need not wait for the browser to observe 10 minutes itself. It is never used for resting
 * durations (15 s averages cannot prove continuous presence) and is discarded unless its contract equals the live
 * depth contract.
 * ========================================================================== */

export type SeedState =
  | { state: 'LOADING' }
  | { state: 'LOADED'; seed: RecordedSeed; validMs: number }
  | { state: 'UNAVAILABLE'; detail: string };

/** A well-formed COMEX outright for this instrument (e.g. GCZ6 / SIH27) - anything else is rejected, never guessed. */
const wellFormed = (root: OfpRoot, c: string | null | undefined): c is string => typeof c === 'string' && new RegExp(`^${root}[FGHJKMNQUVXZ]\\d{1,2}$`).test(c);

/**
 * The ONLY contract for which recorded depth history may be requested or used: the verified trade (chart) contract,
 * and only while the depth feed reports exactly the same contract and nothing reports a contract mismatch.
 * Missing, malformed or differing identifiers -> null (no request, no history).
 */
export function historyContract(root: OfpRoot, tradeContract: string | null | undefined, depthContract: string | null | undefined, mismatch: boolean): string | null {
  if (mismatch || !wellFormed(root, tradeContract) || !wellFormed(root, depthContract)) return null;
  return tradeContract === depthContract ? tradeContract : null;
}

/** A loaded history is usable only for exactly the allowed contract (never another contract's cached history). */
export function usableSeed(state: SeedState | null, contract: string | null): RecordedSeed | null {
  return contract !== null && state?.state === 'LOADED' && state.seed.contract === contract ? state.seed : null;
}

const cache = new Map<string, SeedState>();
const inflight = new Map<string, Promise<SeedState>>();

/** Test hook: forget every cached seed. */
export function resetSeedCache() {
  cache.clear();
  inflight.clear();
}

export function cachedSeed(root: OfpRoot, contract: string): SeedState | null {
  return cache.get(`${root}:${contract}`) ?? null;
}

/**
 * Load (once) the last `lookbackMs` of recorded depth for `root` / `contract`, in the recorder's own 15 s buckets.
 * Same-origin, credentials as the rest of the website. Any failure is final for this page session (UNAVAILABLE).
 */
export function loadRecordedSeed(root: OfpRoot, contract: string, now: number, lookbackMs: number, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<SeedState> {
  const key = `${root}:${contract}`;
  const hit = cache.get(key);
  if (hit && hit.state !== 'LOADING') return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  cache.set(key, { state: 'LOADING' });
  const from = Math.floor(now - lookbackMs);
  const to = Math.ceil(now);
  const p = (async (): Promise<SeedState> => {
    try {
      const r = await fetchImpl(`/api/ibkr/heatmap?root=${root}&from=${from}&to=${to}&bucket=${HEAT_BUCKET_MS}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!r.ok) return { state: 'UNAVAILABLE', detail: `recorded depth unavailable (HTTP ${r.status})` };
      const h = parseHeatmap(await r.json(), root);
      if (!h) return { state: 'UNAVAILABLE', detail: 'recorded depth response rejected (schema)' };
      if (h.contract !== contract) return { state: 'UNAVAILABLE', detail: `recorded depth contract ${h.contract ?? 'none'} ≠ live ${contract} - not used` };
      if (h.bucketMs !== HEAT_BUCKET_MS) return { state: 'UNAVAILABLE', detail: `recorded depth bucket ${h.bucketMs} ms ≠ ${HEAT_BUCKET_MS} ms - not used` };
      const validMs = h.columns.reduce((a, c) => a + c.coverage * h.bucketMs, 0);
      return { state: 'LOADED', seed: { contract, bucketMs: h.bucketMs, columns: h.columns }, validMs };
    } catch {
      return { state: 'UNAVAILABLE', detail: 'recorded depth request failed' };
    }
  })();
  inflight.set(key, p);
  return p.then((s) => {
    cache.set(key, s);
    inflight.delete(key);
    return s;
  });
}
