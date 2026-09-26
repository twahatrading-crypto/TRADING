import type { Candle } from '../../types/market';
import type { VPSettings } from './config';
import type { Acceptance, AcceptanceState, LocationInfo, ProfileState, VolumeNode, VolumeProfile } from './types';

/*
 * PRICE LOCATION vs a profile (tol = nearPocAtr × ATR of the analysis timeframe):
 *   ABOVE VALUE  price > VAH · BELOW VALUE  price < VAL · NEAR POC  |price − POC| ≤ tol
 *   UPPER VALUE  POC + tol < price ≤ VAH · LOWER VALUE  VAL ≤ price < POC − tol
 */
export function locate(price: number, p: Pick<VolumeProfile, 'poc' | 'vah' | 'val'>, atr: number | null, s: Pick<VPSettings, 'nearPocAtr'>): LocationInfo | null {
  if (p.poc === null || p.vah === null || p.val === null) return null;
  const tol = atr ? s.nearPocAtr * atr : 0;
  const location = price > p.vah ? 'ABOVE VALUE' : price < p.val ? 'BELOW VALUE' : Math.abs(price - p.poc) <= tol ? 'NEAR POC' : price > p.poc ? 'UPPER VALUE' : 'LOWER VALUE';
  const d = (x: number) => price - x;
  const a = (x: number) => (atr ? (price - x) / atr : null);
  return { location, price, distPoc: d(p.poc), distVah: d(p.vah), distVal: d(p.val), distPocAtr: a(p.poc), distVahAtr: a(p.vah), distValAtr: a(p.val) };
}

/*
 * ACCEPTANCE / REJECTION against a COMPLETED reference profile, from CLOSED analysis-timeframe bars
 * after the reference ended (n = number of such bars; last = the latest). Checked in this order:
 *   ACCEPTED ABOVE VAH    the last acceptBars (2) closes are all > VAH
 *   ACCEPTED BELOW VAL    the last 2 closes are all < VAL
 *   BREAKING FROM VALUE   the last close is outside [VAL, VAH] but not yet 2 in a row
 *   REJECTED ABOVE VAH    within the last rejectLookback (8) bars a bar traded above VAH (high > VAH) and
 *                         closed back ≤ VAH, and the last close is ≤ VAH
 *   REJECTED BELOW VAL    mirror (low < VAL, close ≥ VAL, last close ≥ VAL)
 *   POC REJECTION         within the last 8 bars a bar touched the POC (low ≤ POC ≤ high) and closed
 *                         ≥ pocRejectAtr (0.5) × ATR away, and the last close is still ≥ 0.5 ATR away on that side
 *   POC ACCEPTANCE        the last pocAcceptBars (3) closes are within nearPocAtr × ATR of the POC
 *   ROTATING INSIDE VALUE the last rotateBars (6) closes are all inside [VAL, VAH]
 *   NO CONFIRMATION       otherwise, or fewer bars than a rule needs, or no ATR
 */
export function acceptance(ref: VolumeProfile | undefined, bars: readonly Candle[], atr: number | null, s: VPSettings, tfSec: number): Acceptance | null {
  if (!ref || !ref.complete || ref.vah === null || ref.val === null || ref.poc === null) return null;
  const after = bars.filter((b) => b.time >= ref.to);
  const mk = (state: AcceptanceState, evidence: string, at: number | null): Acceptance => ({ state, referenceId: ref.id, referenceLabel: ref.label, evidence, at });
  const n = after.length;
  const last = after[n - 1];
  if (!last || !atr) return mk('NO CONFIRMATION', !last ? 'No closed bar since the reference profile ended.' : 'ATR not available.', null);
  const close = (b: Candle) => b.time + tfSec;
  const lastK = after.slice(-s.acceptBars);
  const f = (x: number) => x.toFixed(5).replace(/\.?0+$/, '');
  if (lastK.length === s.acceptBars && lastK.every((b) => b.close > ref.vah!)) return mk('ACCEPTED ABOVE VAH', `${s.acceptBars} consecutive closes above VAH ${f(ref.vah)}`, close(last));
  if (lastK.length === s.acceptBars && lastK.every((b) => b.close < ref.val!)) return mk('ACCEPTED BELOW VAL', `${s.acceptBars} consecutive closes below VAL ${f(ref.val)}`, close(last));
  if (last.close > ref.vah || last.close < ref.val) return mk('BREAKING FROM VALUE', `last close ${f(last.close)} outside value (${f(ref.val)}–${f(ref.vah)}), not yet ${s.acceptBars} closes`, close(last));
  const look = after.slice(-s.rejectLookback);
  const upRej = [...look].reverse().find((b) => b.high > ref.vah! && b.close <= ref.vah!);
  if (upRej) return mk('REJECTED ABOVE VAH', `traded to ${f(upRej.high)} above VAH ${f(ref.vah)} and closed back inside at ${f(upRej.close)}`, close(upRej));
  const dnRej = [...look].reverse().find((b) => b.low < ref.val! && b.close >= ref.val!);
  if (dnRej) return mk('REJECTED BELOW VAL', `traded to ${f(dnRej.low)} below VAL ${f(ref.val)} and closed back inside at ${f(dnRej.close)}`, close(dnRej));
  const away = s.pocRejectAtr * atr;
  const pocRej = [...look].reverse().find((b) => b.low <= ref.poc! && b.high >= ref.poc! && Math.abs(b.close - ref.poc!) >= away);
  if (pocRej && Math.sign(last.close - ref.poc) === Math.sign(pocRej.close - ref.poc) && Math.abs(last.close - ref.poc) >= away)
    return mk('POC REJECTION', `touched POC ${f(ref.poc)} and closed ${((pocRej.close - ref.poc) / atr).toFixed(2)} ATR away; still ≥ ${s.pocRejectAtr} ATR away`, close(pocRej));
  const pa = after.slice(-s.pocAcceptBars);
  if (pa.length === s.pocAcceptBars && pa.every((b) => Math.abs(b.close - ref.poc!) <= s.nearPocAtr * atr)) return mk('POC ACCEPTANCE', `${s.pocAcceptBars} closes within ${s.nearPocAtr} ATR of POC ${f(ref.poc)}`, close(last));
  const rot = after.slice(-s.rotateBars);
  if (rot.length === s.rotateBars && rot.every((b) => b.close >= ref.val! && b.close <= ref.vah!)) return mk('ROTATING INSIDE VALUE', `${s.rotateBars} closes inside value ${f(ref.val)}–${f(ref.vah)}`, close(last));
  return mk('NO CONFIRMATION', `${n} closed bar(s) since the reference ended — no rule satisfied`, null);
}

export function profileState(a: Acceptance | null): ProfileState {
  if (!a) return 'NO DATA';
  switch (a.state) {
    case 'ACCEPTED ABOVE VAH':
      return 'IMBALANCED UP';
    case 'ACCEPTED BELOW VAL':
      return 'IMBALANCED DOWN';
    case 'ROTATING INSIDE VALUE':
    case 'POC ACCEPTANCE':
      return 'BALANCED';
    default:
      return 'TRANSITION';
  }
}

/*
 * NODE STATES (completed profiles only; developing nodes stay ACTIVE and flagged developing):
 *   TESTED   a closed analysis bar after confirmation traded into [low, high]
 *   BROKEN   after confirmation, acceptBars consecutive closes on the far side of the node relative to
 *            the price when the profile completed (price above the node → closes below its low; mirror)
 *   EXPIRED  older than nodeExpirySec since confirmation (and not BROKEN)
 */
export function nodeStates(nodes: readonly VolumeNode[], bars: readonly Candle[], priceAtConfirm: number | null, K: number, s: VPSettings, tfSec: number): VolumeNode[] {
  return nodes.map((n0) => {
    const n = { ...n0 };
    if (n.developing || n.validFrom === null || priceAtConfirm === null) return n;
    const after = bars.filter((b) => b.time >= n.validFrom!);
    const above = priceAtConfirm > n.high;
    let run = 0;
    for (const b of after) {
      if (n.testedAt === null && b.low <= n.high && b.high >= n.low) n.testedAt = b.time + tfSec;
      const far = above ? b.close < n.low : priceAtConfirm < n.low ? b.close > n.high : false;
      run = far ? run + 1 : 0;
      if (run >= s.acceptBars && n.brokenAt === null) n.brokenAt = b.time + tfSec;
    }
    n.state = n.brokenAt !== null ? 'BROKEN' : K - n.validFrom > s.nodeExpirySec ? 'EXPIRED' : n.testedAt !== null ? 'TESTED' : 'ACTIVE';
    return n;
  });
}
