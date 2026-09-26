import type { NewsValue } from './types';

/**
 * Parse a released value as published ("3.2%", "-0.1%", "215K", "1.25M", "4.50%", "52.3").
 * Non-numeric text keeps `value: null` (shown as-is, never compared). Never invents a value.
 */
export function parseValue(v: string | number | null | undefined): NewsValue | null {
  if (v === null || v === undefined) return null;
  const raw = String(v).trim();
  if (!raw || raw === '-' || raw === '—' || raw.toLowerCase() === 'n/a') return null;
  const m = /^([+-]?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.?\d+)\s*(%|[KMBT])?$/i.exec(raw);
  if (!m) return { raw, value: null, unit: null, decimals: 0 };
  const num = m[2]!.replace(/,/g, '');
  const dot = num.indexOf('.');
  const decimals = dot >= 0 ? num.length - dot - 1 : 0;
  const value = Number(`${m[1]}${num}`);
  return { raw, value: Number.isFinite(value) ? value : null, unit: m[3] ? m[3].toUpperCase() : null, decimals };
}

/** Parse a provider time: epoch ms (number) or ISO-8601 WITH an explicit offset / Z. Anything else → null. */
export function parseTime(t: number | string | null | undefined): number | null {
  if (t === null || t === undefined) return null;
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  const s = t.trim();
  // An ISO string without an offset is ambiguous (local? exchange time?) — rejected, never guessed.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export const sameValue = (a: NewsValue | null | undefined, b: NewsValue | null | undefined) => (a ?? null) === (b ?? null) || (!!a && !!b && a.raw === b.raw);
