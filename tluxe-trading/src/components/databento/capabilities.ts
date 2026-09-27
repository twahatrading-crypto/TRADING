import { DATABENTO_STANDARD_DEPTH_REASON, LEVEL2_REQUIRED } from '../../providers/databento/adapters';
import type { DbCapabilities, DbPlan } from '../../providers/databento/protocol';

/** Human labels for the bridge's per-capability states (shared by the strip and Settings). */
const LABEL: Record<string, string> = {
  LIVE: 'LIVE',
  STALE: 'STALE',
  WAITING: 'NOT OBSERVED YET',
  OFFLINE: 'OFFLINE',
  UNAVAILABLE: 'UNAVAILABLE',
  NOT_ENTITLED: 'NOT ENTITLED',
  NOT_REQUESTED: 'NOT REQUESTED',
  REQUESTED: 'REQUESTED',
  ENTITLED: 'ENTITLED',
  UNSUPPORTED: 'UNSUPPORTED',
  SYNCING: 'SYNCING',
  DEGRADED: 'DEGRADED',
};

export const capLabel = (v: string | null | undefined): string => (v ? (LABEL[v] ?? v) : '—');

export const planLabel = (plan: DbPlan | null | undefined): string => (plan === 'standard' ? 'Standard (CME Globex MDP 3.0)' : plan === 'mbo' ? 'MBO (real-time order book)' : '—');

/**
 * Depth notice, or null when Databento supplies a live book. Depth is NEVER approximated from trades / bars:
 * without an entitled order-book source the Heatmap shows DEPTH DATA UNAVAILABLE.
 */
export function depthNotice(caps: DbCapabilities | null, plan: DbPlan | null | undefined): { reason: string; required: string } | null {
  if (caps && (caps.depth === 'UNSUPPORTED' || caps.depth === 'NOT_ENTITLED')) return { reason: caps.depthReason ?? DATABENTO_STANDARD_DEPTH_REASON, required: caps.level2Required ?? LEVEL2_REQUIRED };
  if (!caps && plan === 'standard') return { reason: DATABENTO_STANDARD_DEPTH_REASON, required: LEVEL2_REQUIRED };
  return null;
}
