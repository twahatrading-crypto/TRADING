import { CalendarDays, CalendarX2 } from 'lucide-react';
import { useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { useDisplayTimeZone } from '../../hooks/useDisplayTimeZone';
import { useStore } from '../../store/createStore';
import type { EconomicEvent, EventImportance } from '../../types/calendar';
import { formatHm24, formatShortDate, UNKNOWN } from '../../utils/format';
import { CountryBadge } from '../ui/CountryBadge';
import { EmptyState } from '../ui/EmptyState';
import { Panel } from '../ui/Panel';
import './calendar.css';

type Filter = 'ALL' | EventImportance;
const FILTERS: Filter[] = ['ALL', 'HIGH', 'MEDIUM', 'LOW'];

function Value({ label, v }: { label: string; v: string | null }) {
  return (
    <span className="cal__val">
      <span className="cal__val-label">{label}</span>
      <span className="num">{v ?? UNKNOWN}</span>
    </span>
  );
}

export function CalendarList({ events, tz }: { events: EconomicEvent[]; tz: string }) {
  return (
    <ul className="cal__list">
      {events.map((e) => (
        <li key={e.id} className={`cal__row cal__row--${e.importance.toLowerCase()}`} data-importance={e.importance}>
          <div className="cal__when num">
            <span className="cal__time">{formatHm24(e.time, tz)}</span>
            <span className="cal__date">{formatShortDate(e.time, tz)}</span>
          </div>
          <div className="cal__main">
            <div className="cal__top">
              <CountryBadge code={e.country} />
              <span className="cal__event">{e.event}</span>
              <span className={`cal__imp cal__imp--${e.importance.toLowerCase()}`}>{e.importance}</span>
            </div>
            <div className="cal__vals">
              <Value label="Prev" v={e.previous} />
              <Value label="Fcst" v={e.forecast} />
              <Value label="Actual" v={e.actual} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function CalendarPanel() {
  const { calendar } = useServices();
  const snap = useStore(calendar.store, (s) => s);
  const tz = useDisplayTimeZone();
  const [filter, setFilter] = useState<Filter>('ALL');
  const connected = snap.status === 'CONNECTED';
  const events = filter === 'ALL' ? snap.items : snap.items.filter((e) => e.importance === filter);

  return (
    <Panel
      id="calendar"
      title="Economic Calendar"
      subtitle={connected ? `Source: ${snap.providerName}` : 'Provider: Not Connected'}
      icon={<CalendarDays size={18} />}
      className="cal-panel"
    >
      <div className="cal__filters" role="group" aria-label="Importance filter">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`chip cal__chip cal__chip--${f.toLowerCase()}`}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            disabled={!connected}
          >
            {f}
          </button>
        ))}
      </div>
      {connected && events.length > 0 ? (
        <CalendarList events={events} tz={tz} />
      ) : (
        <EmptyState
          icon={<CalendarX2 size={18} />}
          title={connected ? 'NO EVENTS' : 'ECONOMIC CALENDAR NOT CONNECTED'}
          message={
            connected
              ? 'No scheduled releases match this filter.'
              : 'Scheduled releases with previous, forecast and actual values will appear once a calendar provider is connected.'
          }
          meta="Time · Country · Event · Impact · Prev · Fcst · Actual"
        />
      )}
    </Panel>
  );
}
