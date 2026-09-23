import { SESSIONS, TIMELINE_FUTURE_MS, TIMELINE_PAST_MS } from '../../config/sessions';
import { useNow } from '../../store/clock';
import { formatHm24 } from '../../utils/format';
import { getSessionIntervals } from '../../utils/sessions';
import { timelineTicks, toPercent } from '../../utils/timeline';

export function SessionTimeline({ tz }: { tz: string }) {
  const now = useNow('minute');
  const start = now - TIMELINE_PAST_MS;
  const end = now + TIMELINE_FUTURE_MS;
  const ticks = timelineTicks(start, end, tz, 3);
  // In zones with a :30 offset, whole UTC hours are not whole local hours — fall back to UTC-hour ticks.
  const shown = ticks.length ? ticks : timelineTicks(start, end, 'UTC', 3);
  const nowPct = toPercent(now, start, end);

  return (
    <div className="tl" role="img" aria-label="Session timeline for the next 18 hours">
      <div className="tl__lanes">
        {SESSIONS.map((def) => (
          <div className="tl__lane" key={def.id}>
            <span className="tl__label" title={def.name}>{def.shortName ?? def.name}</span>
            <div className="tl__track">
              {getSessionIntervals(def, start, end).map((iv) => {
                const l = toPercent(iv.open, start, end);
                const r = toPercent(iv.close, start, end);
                return (
                  <span
                    key={iv.open}
                    className={`tl__bar ${iv.open <= now && now < iv.close ? 'is-active' : ''}`}
                    style={{ left: `${l}%`, width: `${r - l}%`, ['--sess' as string]: `var(--s-${def.id})` }}
                    title={`${def.name}: ${formatHm24(iv.open, tz)} – ${formatHm24(iv.close, tz)}`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="tl__axis">
        <span className="tl__label" aria-hidden="true" />
        <div className="tl__ticks">
          {shown.map((t) => (
            <span key={t} className="tl__tick num" style={{ left: `${toPercent(t, start, end)}%` }}>
              {formatHm24(t, tz)}
            </span>
          ))}
        </div>
      </div>
      <div className="tl__now-layer" aria-hidden="true">
        <span className="tl__label" />
        <div className="tl__now-track">
          <span className="tl__now" style={{ left: `${nowPct}%` }}>
            <span className="tl__now-tag num">Now {formatHm24(now, tz)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
