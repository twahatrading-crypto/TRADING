import type { HLEEvent } from '../../engines/highLowEngine/types';
import type { InstrumentId } from '../../types/instruments';

type KV = Pick<Storage, 'getItem' | 'setItem'> | null;
export const SIGNAL_LOG_MAX = 1000;
/** v2: the engine now follows the documented High / Low rules; v1 events came from the previous rule set. */
const key = (id: InstrumentId) => `tluxe.hle.log.v2.${id}`;

/**
 * Persistent, de-duplicated signal log per instrument. Engine events have deterministic ids
 * (instrument:type:subject:time), so re-computation (polling, HMR, refresh) never adds duplicates
 * and history kept here survives the candle window moving on. Storage is written only when
 * something new arrives.
 */
export class SignalLog {
  private readonly cache = new Map<InstrumentId, HLEEvent[]>();
  constructor(private readonly storage: KV) {}

  get(id: InstrumentId): HLEEvent[] {
    let log = this.cache.get(id);
    if (!log) {
      log = [];
      try {
        const raw = this.storage?.getItem(key(id));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) log = (parsed as HLEEvent[]).filter((e) => e && typeof e.id === 'string' && e.instrumentId === id);
      } catch {
        /* unreadable storage — start empty */
      }
      this.cache.set(id, log);
    }
    return log;
  }

  /** Merge engine events; returns the (possibly unchanged) log. */
  merge(id: InstrumentId, events: readonly HLEEvent[]): HLEEvent[] {
    const log = this.get(id);
    const have = new Set(log.map((e) => e.id));
    const fresh = events.filter((e) => e.instrumentId === id && !have.has(e.id));
    if (!fresh.length) return log;
    const next = [...log, ...fresh].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1)).slice(-SIGNAL_LOG_MAX);
    this.cache.set(id, next);
    try {
      this.storage?.setItem(key(id), JSON.stringify(next));
    } catch {
      /* storage full / blocked — the in-memory log still works */
    }
    return next;
  }
}
