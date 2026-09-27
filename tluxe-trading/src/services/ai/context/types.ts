/**
 * READ-ONLY context handed to TLUXE AI. Every field carries provenance: where it came from and how current it is.
 * Missing data is `UNAVAILABLE` with a reason — never an invented value. No credentials, tokens or keys, ever.
 */
export type AiProvenance = 'LIVE' | 'DELAYED' | 'STALE' | 'UNAVAILABLE';

export interface AiField<T> {
  status: AiProvenance;
  /** Data source (e.g. "MT5 bridge", "Databento GLBX.MDP3", "TLUXE S&R engine"). */
  source: string | null;
  /** Epoch ms the value refers to / was computed, when known. */
  asOf: number | null;
  /** Present only when status ≠ UNAVAILABLE. */
  value?: T;
  /** Why the field is unavailable / degraded. */
  reason?: string;
}

export interface AiCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
  closed: boolean | null;
}

export const AI_ENGINE_IDS = ['sr', 'liquidity', 'orderBlocks', 'hlReversal', 'highLow', 'smc', 'volumeProfile', 'volumeFootprint', 'newsAnalysis'] as const;
export type AiEngineId = (typeof AI_ENGINE_IDS)[number];

export interface AiContext {
  schema: 'tluxe.ai.context.v1';
  generatedAt: number;
  readOnly: true;
  instrument: { id: string; name: string; kind: string };
  timeframe: { value: string; source: string };
  provider: AiField<{ name: string; connection: string; feedCode: string | null; providerSymbol: string | null }>;
  freshness: AiField<{ lastMessageAgeMs: number | null }>;
  quote: AiField<{ last: number | null; bid: number | null; ask: number | null; high: number | null; low: number | null; change: number | null; timestamp: number | null }>;
  candles: AiField<{ timeframe: string; count: number; bars: AiCandle[] }>;
  engines: Record<AiEngineId, AiField<unknown>>;
}
