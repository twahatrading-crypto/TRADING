import { TIER_LABEL, type ZoneEvidence } from '../../engines/srPro/analysis';
import { fmtP, fmtSigned, fmtUtc, roleShort, statusLabel, tierTone } from './srProView';

/** Everything known about one zone, with the source of every statement. */
export function ZoneEvidenceView({ ev, d, compact = false }: { ev: ZoneEvidence; d: number; compact?: boolean }) {
  const z = ev.zone;
  return (
    <div className={`srp-ev ${compact ? 'is-compact' : ''}`} data-testid="srp-zone-evidence">
      <div className="srp-ev__head">
        <div>
          <div className={`srp-ev__title is-${z.role}`}>
            {z.timeframe} {roleShort(z).toUpperCase()}
          </div>
          <div className="srp-ev__range">
            {fmtP(z.zoneLow, d)} – {fmtP(z.zoneHigh, d)}
          </div>
        </div>
        <div className="srp-ev__tags">
          <span className={`srp-tier is-${tierTone(ev.tier)}`}>{TIER_LABEL[ev.tier].toUpperCase()}</span>
          <span className="srp-tag">{statusLabel(z.status).toUpperCase()}</span>
        </div>
      </div>
      <div className="srp-ev__stats">
        <div>
          <span>Score</span>
          <b className={`srp-score is-${tierTone(ev.tier)}`}>{ev.tier === 'UNRATED' ? '—' : z.score.total}</b>
        </div>
        <div>
          <span>Touches</span>
          <b>{ev.reactions.touches}</b>
        </div>
        <div>
          <span>Rejections</span>
          <b>{ev.reactions.rejections}</b>
        </div>
        <div>
          <span>Distance</span>
          <b>{fmtSigned(z.distanceFromPrice, d)}</b>
        </div>
      </div>
      <p className="srp-ev__rule">{ev.tierReason}</p>
      {ev.beyond && <p className="srp-note is-warn">{ev.beyond}</p>}

      <h4>Why this rating</h4>
      <ul className="srp-list">
        {ev.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      {!compact && (
        <>
          <h4>Score breakdown (S&amp;R engine)</h4>
          <table className="srp-mini">
            <tbody>
              {ev.scoreLines.map((l) => (
                <tr key={l.key}>
                  <td>{l.label}</td>
                  <td className="num">{l.value}</td>
                  <td className="num srp-muted">× {l.weight}</td>
                  <td className="num">{l.contribution}</td>
                  <td className="srp-muted">{l.explain}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ev.statusFactorNote && <p className="srp-muted">{ev.statusFactorNote}</p>}

          <h4>Evidence</h4>
          <ul className="srp-list">
            {ev.items.map((i) => (
              <li key={i.text}>
                {i.text} {i.inferred && <span className="srp-tag is-inferred">INFERRED</span>}
                <div className="srp-src">{i.source}</div>
              </li>
            ))}
          </ul>
          <p className="srp-muted">
            Reactions: {ev.reactions.rejections} rejection(s), {ev.reactions.sweeps} sweep(s), {ev.reactions.closeThroughs} close-through(s)
            {ev.reactions.meanRejectionAtr !== null && `, mean reaction ${ev.reactions.meanRejectionAtr.toFixed(2)} ATR`} · last test {fmtUtc(ev.reactions.lastAt)}
          </p>
        </>
      )}

      <div className="srp-ev__rules">
        <div>
          <h4>Confirmation</h4>
          <ul className="srp-list">
            {ev.confirmation.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4>Invalidation</h4>
          <ul className="srp-list">
            {ev.invalidation.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="srp-src">
        Structure {ev.structure} · {ev.freshness}
      </p>
    </div>
  );
}
