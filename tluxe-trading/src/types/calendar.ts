export type EventImportance = 'LOW' | 'MEDIUM' | 'HIGH';

export interface EconomicEvent {
  id: string;
  /** Scheduled release time, epoch ms (UTC). */
  time: number;
  /** ISO 3166-1 alpha-2 country / region code, e.g. "US", "EU". */
  country: string;
  currency: string | null;
  event: string;
  importance: EventImportance;
  /** Values are strings because releases carry units ("3.2%", "215K"). Null = not published. */
  previous: string | null;
  forecast: string | null;
  actual: string | null;
}
