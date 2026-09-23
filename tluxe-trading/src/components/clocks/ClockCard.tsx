import { Moon, Sun, X } from 'lucide-react';
import type { ClockConfig } from '../../config/clocks';
import { formatShortDate } from '../../utils/format';
import { formatUtcOffset, getTimeZoneOffsetMinutes, getZonedParts } from '../../utils/time';
import { CountryBadge } from '../ui/CountryBadge';

interface ClockCardProps {
  clock: ClockConfig;
  now: number;
  editing: boolean;
  onRemove?: () => void;
}

export function ClockCard({ clock, now, editing, onRemove }: ClockCardProps) {
  const parts = getZonedParts(now, clock.timeZone);
  const h12 = parts.hour % 12 || 12;
  const ampm = parts.hour < 12 ? 'AM' : 'PM';
  const daytime = parts.hour >= 6 && parts.hour < 18;
  const offset = formatUtcOffset(getTimeZoneOffsetMinutes(now, clock.timeZone));

  return (
    <article className="clock" aria-label={`${clock.city} local time`}>
      <div className="clock__head">
        <CountryBadge code={clock.country} />
        <div className="clock__place">
          <div className="clock__city">{clock.city}</div>
          <div className="clock__region">{clock.region}</div>
        </div>
        {editing && onRemove ? (
          <button type="button" className="clock__remove" onClick={onRemove} aria-label={`Remove ${clock.city}`}>
            <X size={13} />
          </button>
        ) : (
          <span className={`clock__daynight ${daytime ? 'is-day' : 'is-night'}`} title={daytime ? 'Daytime' : 'Night-time'}>
            {daytime ? <Sun size={13} /> : <Moon size={13} />}
          </span>
        )}
      </div>
      <div className="clock__time num" data-testid={`clock-time-${clock.id}`}>
        {String(h12).padStart(2, '0')}:{String(parts.minute).padStart(2, '0')}
        <span className="clock__ampm">{ampm}</span>
      </div>
      <div className="clock__meta num">
        <span>{offset}</span>
        <span>{formatShortDate(now, clock.timeZone)}</span>
      </div>
    </article>
  );
}
