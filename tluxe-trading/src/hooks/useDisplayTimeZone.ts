import { useMemo } from 'react';
import { getBrowserTimeZone } from '../utils/time';

/** Time zone used for session/calendar times: the viewer's local zone. */
export function useDisplayTimeZone(): string {
  return useMemo(getBrowserTimeZone, []);
}
