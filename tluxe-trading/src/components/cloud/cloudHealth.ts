import type { HealthComponent, HealthState } from '../../services/cloud/cloudApi';
import type { StatusTone } from '../../types/status';

/** Tone for a gateway health state. A STALE feed while the market is legitimately closed is not a fault. */
export function healthTone(c: HealthComponent | undefined): StatusTone {
  if (!c) return 'off';
  const s: HealthState = c.state;
  if (s === 'LIVE') return 'ok';
  if (s === 'STALE' && c.expected) return 'off'; // market legitimately closed
  if (s === 'DELAYED' || s === 'STALE') return 'warn';
  if (s === 'ERROR') return 'bad';
  return 'off';
}

export const healthLabel = (c: HealthComponent | undefined) => (!c ? 'UNAVAILABLE' : c.state === 'STALE' && c.expected ? 'MARKET CLOSED' : c.state);
