import {
  BrainCircuit,
  Bug,
  ChartLine,
  Cpu,
  FlaskConical,
  Hammer,
  Microscope,
  Send,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useServices } from '../../app/servicesContext';
import { useDisplayTimeZone } from '../../hooks/useDisplayTimeZone';
import { AI_ACTION_LABELS } from '../../services/ai/AiService';
import { useStore } from '../../store/createStore';
import type { AiActionId, AiTab } from '../../types/ai';
import { formatHm24 } from '../../utils/format';
import { StatusPill } from '../ui/StatusPill';
import './ai.css';

const TABS: { id: AiTab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: BrainCircuit },
  { id: 'research', label: 'Research', icon: Microscope },
  { id: 'analysis', label: 'Analysis', icon: ChartLine },
  { id: 'tools', label: 'Tools', icon: Wrench },
];

const ACTIONS: { id: AiActionId; icon: LucideIcon }[] = [
  { id: 'analyze-market', icon: ChartLine },
  { id: 'check-engine', icon: Cpu },
  { id: 'find-problems', icon: Bug },
  { id: 'deep-research', icon: FlaskConical },
  { id: 'build-feature', icon: Hammer },
];

const TAB_INTRO: Record<AiTab, { title: string; items: string[]; placeholder: string }> = {
  chat: {
    title: 'Your trading research & development workspace.',
    items: [
      'Discuss market structure and trade plans',
      'Answer trading and platform questions',
      'Generate reports and session summaries',
    ],
    placeholder: 'Ask TLUXE AI anything…',
  },
  research: {
    title: 'Deep research across news, macro and filings.',
    items: ['Multi-source web research', 'Macro & Fed policy briefings', 'Cited, reviewable findings'],
    placeholder: 'Describe what to research…',
  },
  analysis: {
    title: 'Structured analysis of GC market data.',
    items: ['Session and range analysis', 'Volatility and volume context', 'Uses connected market data only'],
    placeholder: 'What should be analysed?',
  },
  tools: {
    title: 'Engineering tools for your trading engines.',
    items: ['Inspect and debug engine code', 'Backtest and optimisation runs', 'Feature scaffolding'],
    placeholder: 'Describe the tool task…',
  },
};

export function AiPanel() {
  const { ai, market } = useServices();
  const state = useStore(ai.store, (s) => s);
  const marketConnection = useStore(market.store, (s) => s.connection);
  const tz = useDisplayTimeZone();
  const [tab, setTab] = useState<AiTab>('chat');
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const connected = state.status === 'CONNECTED';
  const marketLive = marketConnection === 'LIVE' || marketConnection === 'DELAYED';
  const intro = TAB_INTRO[tab];

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages.length]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ai.send(tab, draft);
    setDraft('');
  };

  return (
    <section id="ai" className="panel ai" aria-labelledby="ai-title">
      <header className="ai__head">
        <div className="ai__brand">
          <span className="ai__mark" aria-hidden="true"><BrainCircuit size={19} /></span>
          <div className="ai__titles">
            <h2 id="ai-title" className="ai__title">TLUXE AI</h2>
            <div className="ai__subtitle">Trading Research &amp; Development Assistant</div>
          </div>
        </div>
        <StatusPill
          tone={connected ? 'ok' : 'warn'}
          label={connected ? 'Connected' : 'Not Connected'}
          compact
          title={connected ? state.providerName ?? undefined : 'No AI provider configured'}
        />
      </header>

      <div className="ai__tabs" role="tablist" aria-label="AI workspace">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className="ai__tab" onClick={() => setTab(id)}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      <div className="ai__actions" aria-label="Quick actions">
        {ACTIONS.map(({ id, icon: Icon }) => (
          <button key={id} type="button" className="ai__action" onClick={() => void ai.runAction(tab, id)} disabled={state.pending}>
            <Icon size={15} />
            <span>{AI_ACTION_LABELS[id]}</span>
          </button>
        ))}
      </div>

      <div className="ai__log" ref={logRef} aria-live="polite">
        <div className="ai__card">
          <p className="ai__intro-title">{intro.title}</p>
          <ul className="ai__caps">
            {intro.items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
          <dl className="ai__ws">
            <div>
              <dt>AI provider</dt>
              <dd className={connected ? 'is-ok' : 'is-warn'}>{connected ? state.providerName : 'Not connected'}</dd>
            </div>
            <div>
              <dt>Market context</dt>
              <dd className={marketLive ? 'is-ok' : 'is-warn'}>{marketLive ? 'GC live feed' : 'Not connected'}</dd>
            </div>
            <div>
              <dt>Engine access</dt>
              <dd className="is-off">Disabled · Phase 1</dd>
            </div>
          </dl>
          {!connected && (
            <p className="ai__offline" role="note">
              Requests are not sent and no responses are generated until an AI provider is configured.
            </p>
          )}
        </div>
        {state.messages.map((m) => (
          <div key={m.id} className={`ai__msg ai__msg--${m.role}`}>
            <div className="ai__bubble">{m.text}</div>
            <span className="ai__stamp num">{formatHm24(m.createdAt, tz)}</span>
          </div>
        ))}
        {state.pending && <div className="ai__msg ai__msg--assistant"><div className="ai__bubble">…</div></div>}
      </div>

      <div className="ai__composer">
        <form className="ai__input" onSubmit={submit}>
          <label htmlFor="ai-input" className="sr-only">Message TLUXE AI</label>
          <input
            id="ai-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={intro.placeholder}
            autoComplete="off"
          />
          <button type="submit" className="ai__send" aria-label="Send" disabled={!draft.trim() || state.pending}>
            <Send size={16} />
          </button>
        </form>
        <p className="ai__foot">{connected ? `Model: ${state.providerName}` : 'Offline — messages are not sent while the AI provider is disconnected.'}</p>
      </div>
    </section>
  );
}
