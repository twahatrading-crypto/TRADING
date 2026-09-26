import type { SmcSnapshot } from '../smc/types';
import { VP_SCORE_CAP_MISSING, VP_SCORE_WEIGHTS, type VPScoreKey } from './config';
import type { ConfluenceItem, VPScore, VPSnapshot } from './types';

/*
 * VOLUME PROFILE CONFLUENCE SCORE (0–100) = Σ weight × component / 100 (weights in config, total 100):
 *   HTF profile alignment 15  H4 and H1 own-profile locations: same side of value (both above / both
 *                             below / both inside) 100 · only one available 50 · disagree 0
 *   POC significance 10       previous-day POC row share of total volume: 5 % or more = 100, linear below
 *   VAH / VAL interaction 15  previous-day acceptance state: ACCEPTED / REJECTED 100 · POC ACCEPTANCE /
 *                             REJECTION 70 · BREAKING 60 · ROTATING 30 · NO CONFIRMATION 0
 *   HVN / LVN significance 10 strongest ACTIVE / TESTED completed node within 1 ATR of price: strength × 100
 *   Liquidity 15              a Liquidity-engine pool or sweep confluent with a profile level: High 100 / Medium 60
 *   S/R 10                    an S&R zone confluent with a profile level: High 100 / Medium 60
 *   SMC confirmation 15       M15 / M5 CHOCH or displacement at or after the latest value interaction
 *                             100 · any M15 BOS / CHOCH within the last 16 closed M15 bars 50 · none 0
 *   Session confluence 5      current-session POC within 0.5 ATR of a previous-day POC / VAH / VAL 100
 *   Freshness 5               share of ACTIVE (untested) completed nodes × 100
 * MANDATORY evidence: real volume data (not DATA UNAVAILABLE), a completed previous-day profile and an
 * acceptance / rejection state other than NO CONFIRMATION. Missing any → the score is CAPPED at 40.
 * It is an analysis measure — NOT a probability of winning, expected profit or a trade signal.
 */
export const VP_SCORE_NOTE = 'Confluence / analysis score — not a probability of winning, not expected profit, not a trade signal.';

export function vpScore(vp: VPSnapshot, conf: readonly ConfluenceItem[], smc: SmcSnapshot | null): VPScore {
  const c = {} as Record<VPScoreKey, number>;
  const e = {} as Record<VPScoreKey, string>;
  if (vp.unavailable || vp.knowledgeTime === null)
    return { components: Object.fromEntries(Object.keys(VP_SCORE_WEIGHTS).map((k) => [k, 0])) as Record<VPScoreKey, number>, evidence: Object.fromEntries(Object.keys(VP_SCORE_WEIGHTS).map((k) => [k, '—'])) as Record<VPScoreKey, string>, total: null, uncapped: null, missing: ['volume data'], note: `${vp.unavailable ?? 'NO DATA'} — no score. ${VP_SCORE_NOTE}` };
  const side = (l: string | null) => (l === 'ABOVE VALUE' ? 'above' : l === 'BELOW VALUE' ? 'below' : l ? 'inside' : null);
  const h4 = vp.mtf.find((r) => r.timeframe === 'H4');
  const h1 = vp.mtf.find((r) => r.timeframe === 'H1');
  const s4 = h4?.available ? side(h4.location) : null;
  const s1 = h1?.available ? side(h1.location) : null;
  c.htfAlignment = s4 && s1 ? (s4 === s1 ? 100 : 0) : s4 || s1 ? 50 : 0;
  e.htfAlignment = `H4 ${h4?.location ?? '—'} · H1 ${h1?.location ?? '—'}`;
  const pd = vp.profiles.PREVIOUS_DAY;
  const share = pd && pd.total > 0 ? pd.pocVolume / pd.total : 0;
  c.pocSignificance = Math.round(Math.min(1, share / 0.05) * 100);
  e.pocSignificance = pd ? `previous-day POC row = ${(share * 100).toFixed(1)}% of volume` : 'no previous-day profile';
  const st = vp.acceptance?.state ?? 'NO CONFIRMATION';
  c.valueInteraction = st.startsWith('ACCEPTED') || st.startsWith('REJECTED') ? 100 : st.startsWith('POC') ? 70 : st === 'BREAKING FROM VALUE' ? 60 : st === 'ROTATING INSIDE VALUE' ? 30 : 0;
  e.valueInteraction = st;
  const near = vp.nodes.filter((n) => !n.developing && (n.state === 'ACTIVE' || n.state === 'TESTED') && vp.price !== null && vp.atr !== null && Math.abs(n.price - vp.price) <= vp.atr);
  const best = near.sort((a, b) => b.strength - a.strength)[0];
  c.nodeSignificance = best ? Math.round(best.strength * 100) : 0;
  e.nodeSignificance = best ? `${best.type} ${best.price} (${best.strengthLabel}, ${best.state})` : 'no completed node within 1 ATR';
  const liq = conf.filter((x) => x.engine.startsWith('Liquidity'));
  c.liquidity = liq.some((x) => x.strength === 'High') ? 100 : liq.length ? 60 : 0;
  e.liquidity = liq[0] ? `${liq[0].level} + ${liq[0].with}` : 'none';
  const sr = conf.filter((x) => x.engine === 'S&R engine');
  c.sr = sr.some((x) => x.strength === 'High') ? 100 : sr.length ? 60 : 0;
  e.sr = sr[0] ? `${sr[0].level} + ${sr[0].with}` : 'none';
  const m15 = smc?.byTimeframe.M15;
  const m5 = smc?.byTimeframe.M5;
  const since = vp.acceptance?.at ?? null;
  const conf15 = since !== null && [m15, m5].some((x) => x && (x.breaks.some((b) => b.kind === 'CHOCH' && b.validFrom >= since) || x.displacements.some((d) => d.validFrom >= since)));
  const recent = m15 && m15.lastClosedTime !== null ? m15.breaks.some((b) => b.confirmedAt >= m15.lastClosedTime! - 16 * 900) : false;
  c.smc = conf15 ? 100 : recent ? 50 : 0;
  e.smc = conf15 ? 'CHOCH / displacement after the value interaction (SMC engine)' : recent ? 'recent M15 BOS / CHOCH (SMC engine)' : smc ? 'none' : 'SMC data unavailable';
  const cs = vp.profiles.CURRENT_SESSION;
  const refs = pd ? [pd.poc, pd.vah, pd.val].filter((x): x is number => x !== null) : [];
  c.session = cs?.poc != null && vp.atr && refs.some((r) => Math.abs(r - cs.poc!) <= 0.5 * vp.atr!) ? 100 : 0;
  e.session = cs?.poc != null ? `current-session POC ${cs.poc}` : 'no current-session profile';
  const done = vp.nodes.filter((n) => !n.developing);
  c.freshness = done.length ? Math.round((done.filter((n) => n.state === 'ACTIVE').length / done.length) * 100) : 0;
  e.freshness = `${done.filter((n) => n.state === 'ACTIVE').length} of ${done.length} completed nodes untested`;
  let raw = 0;
  for (const k of Object.keys(VP_SCORE_WEIGHTS) as VPScoreKey[]) raw += (VP_SCORE_WEIGHTS[k] * c[k]) / 100;
  const uncapped = Math.round(raw);
  const missing: string[] = [];
  if (!pd || pd.poc === null) missing.push('no completed previous-day profile');
  if (st === 'NO CONFIRMATION') missing.push('no acceptance / rejection confirmation');
  return { components: c, evidence: e, total: missing.length ? Math.min(uncapped, VP_SCORE_CAP_MISSING) : uncapped, uncapped, missing, note: `${missing.length ? `Capped at ${VP_SCORE_CAP_MISSING}: mandatory evidence missing. ` : ''}${VP_SCORE_NOTE}` };
}
