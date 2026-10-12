import type { OfpRoot, OfpTf } from './types';

/** Minimum price increments (CME/COMEX contract specs). */
export const OFP_TICK: Record<OfpRoot, number> = { GC: 0.1, SI: 0.005 };
export const OFP_PRECISION: Record<OfpRoot, number> = { GC: 1, SI: 3 };
export const OFP_ROOTS: readonly OfpRoot[] = ['GC', 'SI'];

export const OFP_TFS: readonly OfpTf[] = ['1m', '5m', '15m', '1h'];
export const OFP_TF_MS: Record<OfpTf, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };

export const isOfpTf = (v: unknown): v is OfpTf => typeof v === 'string' && (OFP_TFS as readonly string[]).includes(v);
export const isOfpRoot = (v: unknown): v is OfpRoot => v === 'GC' || v === 'SI';

/** Value area share (CME convention). */
export const VALUE_AREA = 0.7;

/** Diagonal imbalance ratio and the run length that makes a stacked imbalance. */
export const IMBALANCE_RATIO = 3;
export const STACKED_MIN = 3;

/** Bounded memory: everything older is dropped from the browser engine (the backend database keeps history). */
export const MAX_TRADES = 60_000;
export const MAX_HEAT_COLUMNS = 5_760;
export const MAX_BARS = 600;
export const MAX_TAPE = 400;
export const MAX_ALERTS = 200;

/** Heatmap column width (ms) the recorder buckets resting size into (5 760 columns = 24 h). */
export const HEAT_BUCKET_MS = 15_000;

/** A quote older than this cannot classify a print (-> UNKNOWN). */
export const MAX_QUOTE_AGE_MS = 2_000;

/** Index into the intensity palette: dark blue -> cyan -> green -> yellow -> white. */
export const HEAT_STOPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 8, 22, 70],
  [0.25, 20, 70, 190],
  [0.45, 0, 200, 230],
  [0.65, 40, 220, 110],
  [0.85, 250, 225, 40],
  [1.0, 255, 255, 235],
];

export type IntensityScale = 'linear' | 'sqrt' | 'log';
export const INTENSITY_SCALES: readonly IntensityScale[] = ['linear', 'sqrt', 'log'];

/** Sessions (America/New_York). RTH = COMEX pit-equivalent day session for metals 08:20-13:30 ET. */
export type OfpSession = 'ETH' | 'RTH';
export const OFP_SESSIONS: readonly OfpSession[] = ['ETH', 'RTH'];
export const isOfpSession = (v: unknown): v is OfpSession => v === 'ETH' || v === 'RTH';
