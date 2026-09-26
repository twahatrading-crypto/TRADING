import { HEADLINE_IMPACT_RULE, INDICATORS } from './config';
import type { Dimension, Implication, Implications, Interpretation, NewsCategory, NewsImpact, NewsUpdate, Pressure } from './types';

/*
 * IMPACT CLASSIFICATION
 *   1. The provider's impact, when supplied (source PROVIDER).
 *   2. Otherwise the indicator metadata impact (config INDICATORS) for recognised indicators.
 *   3. Otherwise HEADLINE_IMPACT_RULE by category (central bank / geopolitical = MEDIUM, else LOW).
 *
 * EXPECTED MACRO EFFECT (contextual pressure — NOT a trade signal, NOT the observed reaction):
 *   USD scheduled release with an interpretation (vs forecast):
 *     HOTTER / STRONGER / HAWKISH → USD BULLISH, RATES BULLISH (yields up), GOLD BEARISH,
 *                                   EQUITIES BEARISH (HOTTER / HAWKISH) or MIXED (STRONGER),
 *                                   CRYPTO BEARISH (HOTTER / HAWKISH) or MIXED (STRONGER)
 *     COOLER / WEAKER / DOVISH    → the mirror image
 *     IN LINE                     → NEUTRAL everywhere
 *   EUR / GBP / JPY / CAD / CHF / SEK release (DXY basket): STRONGER / HOTTER / HAWKISH → USD BEARISH
 *     (relative, via DXY), mirror for the opposite; other dimensions UNCERTAIN.
 *   Other currencies: all UNCERTAIN.
 *   Not yet released / no actual / no comparable forecast → INSUFFICIENT DATA.
 *   Speeches, minutes, auctions (no quantitative direction) → UNCERTAIN (text is not interpreted).
 *   GEOPOLITICAL headline (impact ≥ MEDIUM): GOLD BULLISH (safe-haven hypothesis), EQUITIES BEARISH
 *     (risk-off hypothesis), USD / RATES / CRYPTO UNCERTAIN.
 *   Any other headline: UNCERTAIN (direction is never inferred from headline text).
 */

export function classifyImpact(u: Pick<NewsUpdate, 'providerImpact' | 'indicator' | 'category'>): { impact: NewsImpact; source: 'PROVIDER' | 'RULE'; rule: string } {
  if (u.providerImpact) return { impact: u.providerImpact, source: 'PROVIDER', rule: 'impact supplied by the provider' };
  const meta = u.indicator ? INDICATORS.find((m) => m.key === u.indicator) : undefined;
  if (meta) return { impact: meta.impact, source: 'RULE', rule: `indicator rule: ${meta.label} = ${meta.impact}` };
  const impact = HEADLINE_IMPACT_RULE[u.category];
  return { impact, source: 'RULE', rule: `category rule: ${u.category.replace('_', ' ').toLowerCase()} = ${impact}` };
}

const all = (state: Pressure, evidence: string): Implications => ({
  USD: { state, evidence },
  RATES: { state, evidence },
  GOLD: { state, evidence },
  EQUITIES: { state, evidence },
  CRYPTO: { state, evidence },
});
const B: Pressure = 'BULLISH PRESSURE';
const S: Pressure = 'BEARISH PRESSURE';
const flip = (p: Pressure): Pressure => (p === B ? S : p === S ? B : p);
const DXY_CCY = new Set(['EUR', 'GBP', 'JPY', 'CAD', 'CHF', 'SEK']);

export function implications(o: { kind: 'SCHEDULED' | 'HEADLINE'; currency: string | null; category: NewsCategory; indicator: string | null; impact: NewsImpact; interpretation: Interpretation | null; hasActual: boolean }): Implications {
  if (o.kind === 'HEADLINE') {
    if (o.category === 'GEOPOLITICAL' && o.impact !== 'LOW') {
      const r = all('UNCERTAIN', 'Geopolitical headline: effect on this asset is not determined by rule.');
      r.GOLD = { state: B, evidence: 'Geopolitical risk → possible safe-haven demand (hypothesis; observed reaction can differ).' };
      r.EQUITIES = { state: S, evidence: 'Geopolitical risk → possible risk-off (hypothesis; observed reaction can differ).' };
      return r;
    }
    return all('UNCERTAIN', 'Headline text is not interpreted; no rule-based direction.');
  }
  const meta = o.indicator ? INDICATORS.find((m) => m.key === o.indicator) : undefined;
  if (meta?.direction === 'NONE') return all('UNCERTAIN', `${meta.label}: no quantitative release — content is not interpreted.`);
  if (!o.hasActual) return all('INSUFFICIENT DATA', 'Not released yet (no Actual known at this time).');
  if (!o.interpretation) return all('INSUFFICIENT DATA', 'No comparable Forecast / indicator metadata — no surprise can be computed.');
  const i = o.interpretation;
  if (i === 'IN_LINE') return all('NEUTRAL', 'Released in line with the forecast.');
  const up = i === 'HOTTER' || i === 'STRONGER' || i === 'HAWKISH';
  const word = i.toLowerCase();
  if (o.currency === 'USD') {
    const riskAssets: Pressure = i === 'STRONGER' || i === 'WEAKER' ? 'MIXED' : up ? S : B;
    const res: Implications = {
      USD: { state: up ? B : S, evidence: `${word} US data → possible ${up ? 'higher' : 'lower'}-for-longer rate expectations → USD ${up ? 'support' : 'pressure'}.` },
      RATES: { state: up ? B : S, evidence: `${word} US data → possible ${up ? 'upward' : 'downward'} pressure on Treasury yields.` },
      GOLD: { state: up ? S : B, evidence: `${word} US data → ${up ? 'higher' : 'lower'} yields / USD are a possible ${up ? 'headwind' : 'tailwind'} for non-yielding gold.` },
      EQUITIES: { state: riskAssets, evidence: riskAssets === 'MIXED' ? `${word} growth: better earnings outlook vs ${up ? 'higher' : 'lower'} rates — competing effects.` : `${word} US data → rate expectations ${up ? 'up' : 'down'} → possible ${up ? 'headwind' : 'tailwind'} for equities.` },
      CRYPTO: { state: riskAssets, evidence: riskAssets === 'MIXED' ? `${word} growth: risk appetite vs rates — competing effects.` : `${word} US data → liquidity expectations ${up ? 'tighter' : 'looser'} → possible ${up ? 'headwind' : 'tailwind'} for crypto.` },
    };
    return res;
  }
  if (o.currency && DXY_CCY.has(o.currency)) {
    const r = all('UNCERTAIN', `${o.currency} release: no rule for this asset.`);
    r.USD = { state: flip(up ? B : S), evidence: `${word} ${o.currency} data → possible ${o.currency} ${up ? 'strength' : 'weakness'} → relative USD ${up ? 'pressure' : 'support'} via the DXY basket.` };
    return r;
  }
  return all('UNCERTAIN', `${o.currency ?? 'Unknown'} release: no transmission rule for this asset.`);
}

export type { Dimension, Implication };
