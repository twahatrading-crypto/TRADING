import type { Aggressor } from './types';

/**
 * Quote-rule aggressor INFERENCE (Lee-Ready quote test without the tick-test fallback).
 *
 * IBKR trade prints carry no exchange aggressor flag, so this is an inference against the prevailing IBKR quote,
 * never an exchange-confirmed side:
 *   price >= ask -> BUY (lifted the offer) · price <= bid -> SELL (hit the bid) · anything else -> UNKNOWN.
 * Missing, stale, locked or crossed quotes -> UNKNOWN. Inside-spread prints are deliberately NOT guessed by a tick
 * test: an ambiguous print stays UNKNOWN and is excluded from delta (shown as unknown volume).
 */
export function classifyQuoteRule(
  price: number,
  quote: { bid: number | null; ask: number | null; t: number } | null,
  tradeTime: number,
  tick: number,
  maxQuoteAgeMs: number,
): Aggressor {
  if (!quote || quote.bid == null || quote.ask == null) return 'UNKNOWN';
  if (!(quote.ask > quote.bid)) return 'UNKNOWN';
  if (tradeTime - quote.t > maxQuoteAgeMs || quote.t - tradeTime > maxQuoteAgeMs) return 'UNKNOWN';
  const eps = tick * 1e-6;
  if (price >= quote.ask - eps) return 'BUY';
  if (price <= quote.bid + eps) return 'SELL';
  return 'UNKNOWN';
}

/** Integer tick index of a price (prices are always handled as tick indexes to avoid float drift). */
export const toTick = (price: number, tick: number) => Math.round(price / tick);
export const fromTick = (t: number, tick: number) => t * tick;
