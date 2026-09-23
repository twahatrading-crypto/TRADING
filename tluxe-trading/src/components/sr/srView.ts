import { selectDisplayZones } from '../../engines/sr/display';
import { TIMEFRAME_SIGNIFICANCE, type SRSettings } from '../../engines/sr/settings';
import type { SRConfluence, SRSnapshot, SRZone, ZoneStatus } from '../../engines/sr/types';
import type { ConnectionState, Timeframe } from '../../types/market';
import type { ZoneDrawable } from '../chart/ZonesPrimitive';

/* ------------------------------ data state ------------------------------ */

export type SRViewState = 'NOT_CONNECTED' | 'INSUFFICIENT_HISTORY' | 'CATEGORY' | 'STALE' | 'READY';

export const SR_VIEW_TITLE: Record<SRViewState, string> = {
  NOT_CONNECTED: 'MARKET DATA NOT CONNECTED',
  INSUFFICIENT_HISTORY: 'INSUFFICIENT HISTORY',
  CATEGORY: 'S&R DATA UNAVAILABLE',
  STALE: 'MARKET DATA STALE',
  READY: 'S&R LIVE',
};

/** States in which engine zones exist and may be shown (STALE = from the last received candles). */
export const hasZones = (s: SRViewState) => s === 'READY' || s === 'STALE';

/**
 * Truthful state for one timeframe (or ALL): zones exist only when a real
 * provider delivered enough closed candles.
 */
export function srViewState(opts: {
  tradable: boolean;
  connection: ConnectionState;
  snapshots: readonly (SRSnapshot | undefined)[];
}): SRViewState {
  if (!opts.tradable) return 'CATEGORY';
  const snaps = opts.snapshots.filter((s): s is SRSnapshot => !!s);
  const live = opts.connection === 'LIVE' || opts.connection === 'DELAYED';
  if (snaps.some((s) => s.state === 'READY')) return live ? 'READY' : 'STALE';
  if (snaps.some((s) => s.barsProcessed > 0)) return 'INSUFFICIENT_HISTORY';
  return live ? 'INSUFFICIENT_HISTORY' : 'NOT_CONNECTED';
}

/* ------------------------------- filtering ------------------------------ */

export type TypeFilter = 'all' | 'support' | 'resistance';
export type TfFilter = 'ALL' | Timeframe;
export type StatusFilter = 'ALL' | Exclude<ZoneStatus, 'EXPIRED'>;

export interface ZoneFilters {
  type: TypeFilter;
  tf: TfFilter;
  status: StatusFilter;
}

/** Pure view filter. 'ALL' status = every non-expired zone. Never mutates input. */
export function filterZones(zones: readonly SRZone[], f: ZoneFilters): SRZone[] {
  return zones.filter(
    (z) =>
      (f.type === 'all' || z.role === f.type) &&
      (f.tf === 'ALL' || z.timeframe === f.tf) &&
      (f.status === 'ALL' ? z.status !== 'EXPIRED' : z.status === f.status),
  );
}

export type SortKey = 'type' | 'tf' | 'zoneLow' | 'zoneHigh' | 'mid' | 'score' | 'touches' | 'status' | 'distance';
export interface SortSpec {
  key: SortKey;
  dir: 'asc' | 'desc';
}

const TF_ORDER: Record<Timeframe, number> = { M1: 1, M5: 2, M15: 3, M30: 4, H1: 5, H4: 6, D1: 7 };

export function sortZones(zones: readonly SRZone[], s: SortSpec): SRZone[] {
  const val = (z: SRZone): number | string => {
    switch (s.key) {
      case 'type': return z.role;
      case 'tf': return TF_ORDER[z.timeframe];
      case 'zoneLow': return z.zoneLow;
      case 'zoneHigh': return z.zoneHigh;
      case 'mid': return z.midPrice;
      case 'score': return z.score.total;
      case 'touches': return z.touchCount;
      case 'status': return z.status;
      case 'distance': return Math.abs(z.distanceFromPrice ?? Number.POSITIVE_INFINITY);
    }
  };
  const k = s.dir === 'asc' ? 1 : -1;
  return [...zones].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * k || (a.id < b.id ? -1 : 1);
  });
}

/** Rows for the table: ALL TF shows the display-relevant subset unless "show all". */
export function tableRows(zones: readonly SRZone[], f: ZoneFilters, settings: SRSettings, showAll: boolean): { rows: SRZone[]; total: number } {
  const filtered = filterZones(zones, f);
  if (f.tf !== 'ALL' || showAll) return { rows: filtered, total: filtered.length };
  const rows = selectDisplayZones(filtered, settings, { includeStatuses: f.status === 'BROKEN' ? ['BROKEN'] : [] });
  return { rows, total: filtered.length };
}

/* -------------------------------- drawing ------------------------------- */

export const roleLabel = (z: Pick<SRZone, 'role'>) => (z.role === 'support' ? 'SUPPORT' : 'RESISTANCE');

export function zoneLabel(z: SRZone): { label: string; sublabel: string } {
  return {
    label: `${z.timeframe} ${roleLabel(z)} | ${z.score.total}`,
    sublabel: `${z.touchCount} ${z.touchCount === 1 ? 'touch' : 'touches'} | ${z.status}`,
  };
}

/** Zones to draw: display-ranked subset + anything selected/highlighted. */
export function chartDrawables(opts: {
  zones: readonly SRZone[];
  filters: ZoneFilters;
  settings: SRSettings;
  selectedZoneId: string | null;
  confluence: SRConfluence | null;
}): ZoneDrawable[] {
  const { zones, filters, settings, selectedZoneId, confluence } = opts;
  const members = new Set(confluence?.zoneIds ?? []);
  const shown = selectDisplayZones(filterZones(zones, filters), settings, { includeStatuses: filters.status === 'BROKEN' ? ['BROKEN'] : [] });
  const ids = new Set(shown.map((z) => z.id));
  const extra = zones.filter((z) => !ids.has(z.id) && (z.id === selectedZoneId || members.has(z.id)));
  return [...shown, ...extra].map((z) => ({
    id: z.id,
    role: z.role,
    low: z.zoneLow,
    high: z.zoneHigh,
    from: z.createdAt,
    emphasis: TIMEFRAME_SIGNIFICANCE[z.timeframe] / 100,
    ...zoneLabel(z),
    selected: z.id === selectedZoneId,
    highlighted: members.has(z.id),
    dimmed: members.size > 0 && !members.has(z.id) && z.id !== selectedZoneId,
  }));
}

/* ------------------------------ formatting ------------------------------ */

export function formatAge(fromSec: number, nowMs: number): string {
  const mins = Math.max(0, Math.floor((nowMs / 1000 - fromSec) / 60));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h ago`;
  if (h > 0) return `${h}h ${m}m ago`;
  return `${m}m ago`;
}

export const STATUS_CLASS: Record<ZoneStatus, string> = {
  FRESH: 'st-fresh',
  ACTIVE: 'st-active',
  TESTED: 'st-tested',
  WEAKENING: 'st-weak',
  BROKEN: 'st-broken',
  FLIPPED: 'st-flipped',
  EXPIRED: 'st-expired',
};
