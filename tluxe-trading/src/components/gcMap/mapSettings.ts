import type { Timeframe } from '../../types/market';
import { DEFAULT_STRONG } from './liquidityMap';

/* GC Liquidity Map - page settings (display / highlight only; never an input to recorded depth). */

export const MAP_TFS = ['M1', 'M5', 'M15', 'M30', 'H1'] as const satisfies readonly Timeframe[];
export type MapTf = (typeof MAP_TFS)[number];
export const TF_LABEL: Record<MapTf, string> = { M1: '1m', M5: '5m', M15: '15m', M30: '30m', H1: '1H' };
export const TF_MS: Record<MapTf, number> = { M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000, H1: 3_600_000 };
/** Finest recorded-depth bucket the page requests (the server's own minimum); the bucket follows the VIEWPORT only. */
export const MIN_DEPTH_BUCKET_MS = 250;

export interface MapSettings {
  candles: boolean;
  heat: boolean;
  depth: boolean;
  strongOnly: boolean;
  labels: boolean;
  gain: number;
  minSize: number;
  minRelative: number;
  minPersistS: number;
  /** Max distance from the market ($). */
  maxDistance: number;
}
export const DEFAULT_MAP_SETTINGS: MapSettings = { candles: true, heat: true, depth: true, strongOnly: false, labels: true, gain: 1, minSize: DEFAULT_STRONG.minSize, minRelative: DEFAULT_STRONG.minRelative, minPersistS: DEFAULT_STRONG.minPersistMs / 1000, maxDistance: 5 };
export const isMapSettings = (v: unknown): v is MapSettings => !!v && typeof v === 'object' && (Object.keys(DEFAULT_MAP_SETTINGS) as (keyof MapSettings)[]).every((k) => typeof (v as MapSettings)[k] === typeof DEFAULT_MAP_SETTINGS[k]);
export const isMapTf = (v: unknown): v is MapTf => MAP_TFS.includes(v as MapTf);

