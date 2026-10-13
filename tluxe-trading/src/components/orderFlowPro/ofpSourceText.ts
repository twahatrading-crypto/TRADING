import type { ReplayProvenance, SourceStatus } from '../../engines/orderFlowPro/types';

/* Order Flow Pro wording that depends on the data source (local IBKR backend vs the TLUXE gateway). */

export const DEPTH_LIMITS_TEXT =
  'IBKR market depth = aggregated PRICE LEVELS (MBP) for the rows IBKR grants, direct COMEX (not SMART depth). It is not the full COMEX book, carries no order IDs (not MBO) and no exchange timestamps (backend receive time is used). Displayed size can be pulled at any time; a reduction is not proof of a fill or a cancel.';

export const CLASSIFICATION_TEXT =
  'Side = quote-rule INFERENCE against the IBKR bid / ask (at/above ask → BUY, at/below bid → SELL). Not exchange-confirmed. A side is assigned only when that bid / ask was confirmed by its own stream within the maximum quote age (2 s) on real-time data; stale, missing, delayed, inside-spread, locked / crossed prints stay UNKNOWN and are excluded from delta, CVD and imbalances.';

export const GATEWAY_CLASSIFICATION_TEXT =
  'Side = the AGGRESSOR side reported by the exchange (CME MDP3, delivered by Databento): B = buyer-initiated → BUY, A = seller-initiated → SELL. Prints the exchange does not attribute (N) stay UNKNOWN and are excluded from delta, CVD and imbalances. Nothing is inferred.';

export const GATEWAY_DEPTH_TEXT =
  'IBKR market depth via the TLUXE gateway = aggregated PRICE LEVELS (10 rows per side) for the same COMEX contract as the trades - accepted only when both report the same contract. Not the full COMEX book, no order IDs (not MBO). Timestamps are the VPS depth-service update time, not exchange time; changes are net differences between ~250 ms snapshots. Trades (exchange time) and depth (VPS time) are different clocks, so at-touch comparisons carry that uncertainty. Displayed size can be pulled at any time; a reduction is not proof of a fill or a cancel.';

/** Wording that depends on the data source. Without gateway provenance it returns the original IBKR-backend text. */
export function sourceText(st: SourceStatus, demo: boolean) {
  const gw = !!st.provenance && !demo;
  return {
    gateway: gw,
    provider: demo ? 'DEMO fixture' : gw ? 'Databento + IBKR (read-only)' : 'IBKR (read-only)',
    subtitle: gw ? 'COMEX futures · Databento trades + IBKR depth · research only' : 'COMEX futures · IBKR · research only',
    sideHeader: gw ? 'Side (exchange)' : 'Side (inferred)',
    sideTitle: gw ? 'Aggressor side reported by the exchange (CME via Databento); not reported → UNKNOWN' : 'Quote-rule inference, not exchange-confirmed',
    basisHeader: gw ? 'Basis · receipt lag' : 'Basis · quote age',
    basisTitle: gw ? 'Exchange aggressor basis, and the exchange → Databento receipt lag of the print' : 'Why the side was (not) inferred, and the age of the bid / ask it was compared with',
    buySell: gw ? 'Buy / Sell (exchange aggressor)' : 'Buy / Sell (inferred)',
    aggressorCap: gw ? 'Aggressor (exchange)' : 'Aggressor (quote rule)',
    classification: gw ? GATEWAY_CLASSIFICATION_TEXT : CLASSIFICATION_TEXT,
    depthLimits: gw ? GATEWAY_DEPTH_TEXT : DEPTH_LIMITS_TEXT,
    ofiTitle: gw ? 'Top-of-book OFI (Cont-Kukanov-Stoikov) from the IBKR price-level book' : 'Top-of-book OFI (Cont-Kukanov-Stoikov) from IBKR quotes',
    footer: gw
      ? 'Databento CME trades (exchange time, exchange-reported aggressor) · IBKR price-level depth (10 rows, VPS update time; not full book, not MBO) · research only — no orders, no signals to trade'
      : 'IBKR price-level depth (not full book, not MBO) · quote-rule inferred sides · research only — no orders, no signals to trade',
  };
}

/** Replay description: exact prints vs recorded depth aggregates - never presented as an exact book replay. */
export function replayText(p: ReplayProvenance | null): string {
  if (!p) return 'recorded data, not live';
  const t = p.trades;
  const d = p.depth;
  const trades = `trades: ${t.count.toLocaleString('en-US')} exact historical prints${t.complete ? '' : ` (incomplete: ${t.detail ?? 'see gaps'})`}`;
  const depth =
    d.kind === 'RECORDED_TIME_WEIGHTED_AGGREGATE'
      ? `depth: RECORDED AVERAGES (time-weighted per ${(d.bucketMs ?? 0) / 1000} s bucket, ${d.coveredBuckets}/${d.buckets} buckets fully covered) - NOT an exact order-book replay`
      : `depth: none${d.detail ? ` (${d.detail})` : ''}`;
  return `${trades} · ${depth} · exact historical book snapshots: not available · gaps: ${p.gaps.length}`;
}
