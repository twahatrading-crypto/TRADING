import { INDICATORS, type IndicatorDirection } from './config';
import type { ComparisonLabel, Interpretation, NewsValue, SurpriseResult } from './types';

/*
 * SURPRISE (deterministic, only where mathematically valid):
 *   compare(actual, base): both numeric AND the same unit (%, K, M, B, T or none); values rounded to
 *   the larger published precision; equal → IN LINE, greater → ABOVE, smaller → BELOW. Different
 *   units / non-numeric text → NOT COMPARABLE. Missing base → NO FORECAST / NO PREVIOUS; missing
 *   actual → NO ACTUAL. The Previous used is the latest Previous known at the evaluation time
 *   (a revision is only used once it was published).
 *   Interpretation from indicator metadata (vs FORECAST only):
 *     INFLATION         above → HOTTER,   below → COOLER
 *     ACTIVITY          above → STRONGER, below → WEAKER
 *     INVERSE_ACTIVITY  above → WEAKER,   below → STRONGER   (e.g. unemployment, jobless claims)
 *     POLICY_RATE       above → HAWKISH,  below → DOVISH
 *     NONE / unknown    no interpretation
 */
export function compare(actual: NewsValue | null, base: NewsValue | null): ComparisonLabel {
  if (!actual) return 'MISSING_ACTUAL';
  if (!base) return 'MISSING_BASE';
  if (actual.value === null || base.value === null || actual.unit !== base.unit) return 'NOT_COMPARABLE';
  const d = Math.max(actual.decimals, base.decimals);
  const a = Number(actual.value.toFixed(d));
  const b = Number(base.value.toFixed(d));
  return a === b ? 'IN_LINE' : a > b ? 'ABOVE' : 'BELOW';
}

const LABEL = (c: ComparisonLabel, base: 'FORECAST' | 'PREVIOUS') =>
  c === 'ABOVE' ? `ABOVE ${base}` : c === 'BELOW' ? `BELOW ${base}` : c === 'IN_LINE' ? 'IN LINE' : c === 'MISSING_BASE' ? `NO ${base}` : c === 'MISSING_ACTUAL' ? 'NO ACTUAL' : 'NOT COMPARABLE';

export function interpret(direction: IndicatorDirection | null, c: ComparisonLabel): Interpretation | null {
  if (c === 'IN_LINE') return 'IN_LINE';
  if (c !== 'ABOVE' && c !== 'BELOW') return null;
  const up = c === 'ABOVE';
  switch (direction) {
    case 'INFLATION':
      return up ? 'HOTTER' : 'COOLER';
    case 'ACTIVITY':
      return up ? 'STRONGER' : 'WEAKER';
    case 'INVERSE_ACTIVITY':
      return up ? 'WEAKER' : 'STRONGER';
    case 'POLICY_RATE':
      return up ? 'HAWKISH' : 'DOVISH';
    default:
      return null;
  }
}

export function surprise(indicator: string | null, actual: NewsValue | null, forecast: NewsValue | null, previous: NewsValue | null): SurpriseResult {
  const meta = indicator ? INDICATORS.find((m) => m.key === indicator) : undefined;
  const cf = compare(actual, forecast);
  const cp = compare(actual, previous);
  const num = (c: ComparisonLabel) => c === 'ABOVE' || c === 'BELOW' || c === 'IN_LINE';
  const dF = num(cf) ? actual!.value! - forecast!.value! : null;
  const dP = num(cp) ? actual!.value! - previous!.value! : null;
  const interpretation = meta ? interpret(meta.direction, cf) : null;
  return {
    vsForecast: LABEL(cf, 'FORECAST'),
    vsPrevious: LABEL(cp, 'PREVIOUS'),
    deltaForecast: dF === null ? null : Number(dF.toFixed(Math.max(actual!.decimals, forecast!.decimals))),
    deltaForecastPct: dF === null || forecast!.value === 0 ? null : (dF / Math.abs(forecast!.value!)) * 100,
    deltaPrevious: dP === null ? null : Number(dP.toFixed(Math.max(actual!.decimals, previous!.decimals))),
    interpretation,
    rule: meta ? `${meta.label}: higher print = ${meta.direction.replace('_', ' ').toLowerCase()}` : 'No indicator metadata — no economic interpretation.',
  };
}
