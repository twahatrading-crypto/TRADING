import { useDisplayTimeZone } from '../../hooks/useDisplayTimeZone';
import { useNow } from '../../store/clock';
import { formatClockTime, formatHm24, formatLongDate, timeZoneAbbrev } from '../../utils/format';

export function HeaderClock() {
  const now = useNow('second');
  const tz = useDisplayTimeZone();
  return (
    <div className="hclock" aria-label="Current date and time">
      <div className="hclock__date">{formatLongDate(now, tz)}</div>
      <div className="hclock__time num">{formatClockTime(now, tz, true)}</div>
      <div className="hclock__zone num">
        {timeZoneAbbrev(now, tz)} · UTC {formatHm24(now, 'UTC')}
      </div>
    </div>
  );
}
