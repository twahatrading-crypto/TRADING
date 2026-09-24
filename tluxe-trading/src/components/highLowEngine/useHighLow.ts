import { useEffect, useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { useActiveInstrumentId } from '../../hooks/useMarket';
import type { HLEInstrumentState } from '../../services/highLowEngine/HighLowEngineService';
import { useStore } from '../../store/createStore';

/** Active instrument's High / Low Engine state (computed by the service, never in React). */
export function useHighLowState<T>(selector: (s: HLEInstrumentState) => T): T {
  const { highLow } = useServices();
  const id = useActiveInstrumentId();
  return useStore(highLow.store(id), selector);
}

/** Wall clock for display only (world clocks, session countdown, "x s ago"). */
export function useNow(stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}

export const fmtTime = (sec: number | null, tz: string) =>
  sec === null ? '—' : new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h12' }).format(sec * 1000);
export const fmtShort = (sec: number | null, tz: string) =>
  sec === null ? '—' : new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(sec * 1000);
export const fmtUtc = (sec: number | null) => (sec === null ? '—' : `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
export const ago = (ms: number | null, now: number) => (ms === null ? '—' : `${Math.max(0, Math.round((now - ms) / 1000))} s ago`);
