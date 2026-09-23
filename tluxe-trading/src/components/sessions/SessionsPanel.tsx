import { Activity } from 'lucide-react';
import { SESSIONS, UPCOMING_WINDOW_MS } from '../../config/sessions';
import { useDisplayTimeZone } from '../../hooks/useDisplayTimeZone';
import { useNow } from '../../store/clock';
import { formatHm24, timeZoneAbbrev } from '../../utils/format';
import { formatCountdown, getSessionState, type SessionDefinition, type SessionState } from '../../utils/sessions';
import { Panel } from '../ui/Panel';
import { StatusDot } from '../ui/StatusPill';
import { SessionTimeline } from './SessionTimeline';
import './sessions.css';

const STATUS_LABEL = { OPEN: 'Open', CLOSED: 'Closed', UPCOMING: 'Upcoming' } as const;

export function SessionCard({ def, state, tz }: { def: SessionDefinition; state: SessionState; tz: string }) {
  const iv = state.current ?? state.next;
  const isOpen = state.status === 'OPEN';
  return (
    <article className={`sess sess--${state.status.toLowerCase()}`} style={{ ['--sess' as string]: `var(--s-${def.id})` }} aria-label={`${def.name} session`}>
      <div className="sess__head">
        <span className="sess__swatch" aria-hidden="true" />
        <span className="sess__name">{def.name}</span>
      </div>
      <div className="sess__hours num" title={def.rule}>
        {formatHm24(iv.open, tz)} – {formatHm24(iv.close, tz)}
      </div>
      <div className={`sess__status sess__status--${state.status.toLowerCase()}`} data-testid={`session-status-${def.id}`}>
        {STATUS_LABEL[state.status]}
      </div>
      <div className="sess__count num">
        {isOpen ? 'Closes in ' : 'Opens in '}
        <strong>{formatCountdown(state.countdownMs)}</strong>
      </div>
      {isOpen && state.progress !== null && (
        <div className="sess__progress" aria-hidden="true">
          <span style={{ width: `${Math.round(state.progress * 100)}%` }} />
        </div>
      )}
    </article>
  );
}

export function SessionsPanel() {
  const now = useNow('second');
  const tz = useDisplayTimeZone();
  const states = SESSIONS.map((def) => ({ def, state: getSessionState(def, now, UPCOMING_WINDOW_MS) }));
  const open = states.filter((s) => s.state.status === 'OPEN').map((s) => s.def.name);

  return (
    <Panel
      id="sessions"
      title="Trading Sessions"
      subtitle={`Times in ${timeZoneAbbrev(now, tz)} (${tz}) · regular hours, holidays not modelled`}
      icon={<Activity size={18} />}
      actions={
        <span className="sess-live">
          <StatusDot tone={open.length ? 'ok' : 'off'} pulse={open.length > 0} />
          {open.length ? <>Open: {open.join(', ')}</> : 'All sessions closed'}
        </span>
      }
    >
      <div className="sess-grid">
        {states.map(({ def, state }) => (
          <SessionCard key={def.id} def={def} state={state} tz={tz} />
        ))}
      </div>
      <SessionTimeline tz={tz} />
    </Panel>
  );
}
