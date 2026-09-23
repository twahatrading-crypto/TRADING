export type StatusValue =
  | 'ONLINE'
  | 'OFFLINE'
  | 'CONNECTED'
  | 'NOT CONNECTED'
  | 'DISABLED'
  | 'ERROR'
  /** The instrument has no source of this kind at all (e.g. no depth for OTC FX). */
  | 'UNSUPPORTED';

export type StatusTone = 'ok' | 'warn' | 'bad' | 'off';

export interface SystemStatusItem {
  id: string;
  label: string;
  value: StatusValue;
  detail?: string;
}
