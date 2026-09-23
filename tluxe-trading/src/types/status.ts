export type StatusValue =
  | 'ONLINE'
  | 'OFFLINE'
  | 'CONNECTED'
  | 'NOT CONNECTED'
  | 'DISABLED'
  | 'ERROR';

export type StatusTone = 'ok' | 'warn' | 'bad' | 'off';

export interface SystemStatusItem {
  id: string;
  label: string;
  value: StatusValue;
  detail?: string;
}
