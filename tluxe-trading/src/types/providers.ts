/** Connection status shared by non-market providers (news, calendar, AI, database). */
export type ProviderStatus = 'CONNECTED' | 'CONNECTING' | 'NOT_CONNECTED' | 'ERROR';

export interface ProviderSnapshot<T> {
  status: ProviderStatus;
  providerName: string | null;
  items: T[];
  lastUpdated: number | null;
  error: string | null;
}
