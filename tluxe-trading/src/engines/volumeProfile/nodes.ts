import type { VPSettings } from './config';
import type { ProfileRow, VolumeNode } from './types';

/*
 * HVN / LVN on 3-row smoothed volume s (mean of the row and its neighbours), rel = s / max(s):
 *   HVN  s[i] is the maximum within ±nodeWindowRows rows AND rel ≥ hvnMinRel (0.6) AND it stands out:
 *        s[i] − min(s within ±2 × nodeWindowRows) ≥ hvnProminence (0.15) × max (flat profiles have no HVN)
 *   LVN  s[i] is the minimum within ±nodeWindowRows rows AND rel ≤ lvnMaxRel (0.35) AND there is a
 *        peak on BOTH sides with s[i] ≤ lvnFlankRatio (0.5) × each flank peak (a real valley between
 *        two volume areas — never a thin tail at the profile's edge)
 *   Nodes closer than nodeMergeRows rows are merged (the strongest is kept).
 *   Range: HVN extends while s ≥ 0.85 × peak; LVN while s ≤ 1.15 × trough (plus the row itself).
 *   Strength: HVN = rel; LVN = 1 − s / min(flank peaks). Strong ≥ 0.8 (HVN) / 0.7 (LVN), Medium ≥ 0.6 / 0.5.
 */
export interface RawNode {
  type: 'HVN' | 'LVN';
  index: number;
  lowIndex: number;
  highIndex: number;
  rel: number;
  strength: number;
  volume: number;
}

export const HVN_PROMINENCE = 0.15;

export function smooth(rows: readonly ProfileRow[]): number[] {
  return rows.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let k = i - 1; k <= i + 1; k++) {
      if (k < 0 || k >= rows.length) continue;
      s += rows[k]!.volume;
      n += 1;
    }
    return s / n;
  });
}

export function detectNodes(rows: readonly ProfileRow[], s: Pick<VPSettings, 'nodeWindowRows' | 'hvnMinRel' | 'lvnMaxRel' | 'lvnFlankRatio' | 'nodeMergeRows'>): RawNode[] {
  if (rows.length < 2 * s.nodeWindowRows + 1) return [];
  const sm = smooth(rows);
  const max = Math.max(...sm);
  if (!(max > 0)) return [];
  const w = s.nodeWindowRows;
  const out: RawNode[] = [];
  for (let i = 0; i < sm.length; i++) {
    const lo = Math.max(0, i - w);
    const hi = Math.min(sm.length - 1, i + w);
    let isMax = true;
    let isMin = true;
    for (let k = lo; k <= hi; k++) {
      if (k === i) continue;
      if (sm[k]! > sm[i]! || (sm[k] === sm[i] && k < i)) isMax = false;
      if (sm[k]! < sm[i]! || (sm[k] === sm[i] && k < i)) isMin = false;
    }
    const rel = sm[i]! / max;
    const pw = Math.max(0, i - 2 * w);
    const pwh = Math.min(sm.length - 1, i + 2 * w);
    const floor = Math.min(...sm.slice(pw, pwh + 1));
    if (isMax && rel >= s.hvnMinRel && sm[i]! - floor >= HVN_PROMINENCE * max) {
      let a = i;
      let b = i;
      while (a > 0 && sm[a - 1]! >= 0.85 * sm[i]!) a -= 1;
      while (b < sm.length - 1 && sm[b + 1]! >= 0.85 * sm[i]!) b += 1;
      out.push({ type: 'HVN', index: i, lowIndex: a, highIndex: b, rel, strength: rel, volume: rows[i]!.volume });
    }
    if (isMin && rel <= s.lvnMaxRel) {
      const left = Math.max(...sm.slice(0, i), 0);
      const right = Math.max(...sm.slice(i + 1), 0);
      const flank = Math.min(left, right);
      if (flank > 0 && sm[i]! <= s.lvnFlankRatio * left && sm[i]! <= s.lvnFlankRatio * right) {
        let a = i;
        let b = i;
        while (a > 0 && sm[a - 1]! <= 1.15 * sm[i]! + 1e-12) a -= 1;
        while (b < sm.length - 1 && sm[b + 1]! <= 1.15 * sm[i]! + 1e-12) b += 1;
        out.push({ type: 'LVN', index: i, lowIndex: a, highIndex: b, rel, strength: 1 - sm[i]! / flank, volume: rows[i]!.volume });
      }
    }
  }
  // Merge nodes of the same type that are too close (keep the strongest; ties → lower index).
  const kept: RawNode[] = [];
  for (const n of [...out].sort((a, b) => b.strength - a.strength || a.index - b.index)) {
    if (kept.some((k) => k.type === n.type && Math.abs(k.index - n.index) < s.nodeMergeRows)) continue;
    kept.push(n);
  }
  return kept.sort((a, b) => a.index - b.index || (a.type < b.type ? -1 : 1));
}

export const strengthLabel = (n: Pick<VolumeNode, 'type' | 'strength'>): VolumeNode['strengthLabel'] =>
  n.type === 'HVN' ? (n.strength >= 0.8 ? 'Strong' : n.strength >= 0.6 ? 'Medium' : 'Weak') : n.strength >= 0.7 ? 'Strong' : n.strength >= 0.5 ? 'Medium' : 'Weak';
