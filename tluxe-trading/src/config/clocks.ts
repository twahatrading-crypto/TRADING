export interface ClockConfig {
  id: string;
  city: string;
  region: string;
  /** ISO country code shown as a badge. */
  country: string;
  timeZone: string;
}

export const DEFAULT_CLOCKS: ClockConfig[] = [
  { id: 'denver', city: 'Denver', region: 'United States', country: 'US', timeZone: 'America/Denver' },
  { id: 'new-york', city: 'New York', region: 'United States', country: 'US', timeZone: 'America/New_York' },
  { id: 'london', city: 'London', region: 'United Kingdom', country: 'GB', timeZone: 'Europe/London' },
  { id: 'yangon', city: 'Yangon', region: 'Myanmar', country: 'MM', timeZone: 'Asia/Yangon' },
  { id: 'kuala-lumpur', city: 'Kuala Lumpur', region: 'Malaysia', country: 'MY', timeZone: 'Asia/Kuala_Lumpur' },
];

/** Additional locations offered in the clock editor. */
export const CLOCK_CATALOG: ClockConfig[] = [
  ...DEFAULT_CLOCKS,
  { id: 'chicago', city: 'Chicago', region: 'United States', country: 'US', timeZone: 'America/Chicago' },
  { id: 'los-angeles', city: 'Los Angeles', region: 'United States', country: 'US', timeZone: 'America/Los_Angeles' },
  { id: 'toronto', city: 'Toronto', region: 'Canada', country: 'CA', timeZone: 'America/Toronto' },
  { id: 'sao-paulo', city: 'São Paulo', region: 'Brazil', country: 'BR', timeZone: 'America/Sao_Paulo' },
  { id: 'frankfurt', city: 'Frankfurt', region: 'Germany', country: 'DE', timeZone: 'Europe/Berlin' },
  { id: 'zurich', city: 'Zurich', region: 'Switzerland', country: 'CH', timeZone: 'Europe/Zurich' },
  { id: 'dubai', city: 'Dubai', region: 'UAE', country: 'AE', timeZone: 'Asia/Dubai' },
  { id: 'mecca', city: 'Mecca', region: 'Saudi Arabia', country: 'SA', timeZone: 'Asia/Riyadh' },
  { id: 'mumbai', city: 'Mumbai', region: 'India', country: 'IN', timeZone: 'Asia/Kolkata' },
  { id: 'singapore', city: 'Singapore', region: 'Singapore', country: 'SG', timeZone: 'Asia/Singapore' },
  { id: 'hong-kong', city: 'Hong Kong', region: 'Hong Kong', country: 'HK', timeZone: 'Asia/Hong_Kong' },
  { id: 'shanghai', city: 'Shanghai', region: 'China', country: 'CN', timeZone: 'Asia/Shanghai' },
  { id: 'tokyo', city: 'Tokyo', region: 'Japan', country: 'JP', timeZone: 'Asia/Tokyo' },
  { id: 'sydney', city: 'Sydney', region: 'Australia', country: 'AU', timeZone: 'Australia/Sydney' },
  { id: 'utc', city: 'UTC', region: 'Coordinated Universal Time', country: 'UTC', timeZone: 'UTC' },
];

export const MAX_CLOCKS = 8;
