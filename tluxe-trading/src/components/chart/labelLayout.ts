/**
 * Deterministic vertical label placement: each label wants to sit at its
 * zone's centre; labels are placed in priority order and nudged to the nearest
 * free slot so none overlap and all stay inside the pane.
 */
export interface LabelRequest {
  id: string;
  /** Desired centre y (px). */
  y: number;
  height: number;
  /** Lower = placed first (keeps its preferred spot). */
  priority: number;
}

export interface PlacedLabel {
  id: string;
  top: number;
  height: number;
}

export function layoutLabels(requests: readonly LabelRequest[], paneHeight: number, gap = 3): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const order = [...requests].sort((a, b) => a.priority - b.priority || a.y - b.y || (a.id < b.id ? -1 : 1));
  const collides = (top: number, h: number) => placed.some((p) => top < p.top + p.height + gap && top + h + gap > p.top);
  for (const r of order) {
    const clampTop = (t: number) => Math.min(Math.max(t, 0), Math.max(0, paneHeight - r.height));
    const want = clampTop(r.y - r.height / 2);
    let top = want;
    if (collides(top, r.height)) {
      // Search outward (down, then up) in label-height steps for the nearest free slot.
      let found: number | null = null;
      for (let k = 1; k < 200 && found === null; k++) {
        for (const dir of [1, -1]) {
          const t = clampTop(want + dir * k * (r.height + gap) * 0.5);
          if (!collides(t, r.height)) {
            found = t;
            break;
          }
        }
      }
      if (found === null) continue; // no room: skip the label (zone is still drawn)
      top = found;
    }
    placed.push({ id: r.id, top, height: r.height });
  }
  return placed;
}
