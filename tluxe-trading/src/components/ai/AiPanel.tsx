import {
  BrainCircuit,
  Bug,
  ChartLine,
  Cpu,
  FlaskConical,
  Hammer,
  Microscope,
  RotateCcw,
  Send,
  Square,
  Trash2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useServices } from '../../app/servicesContext';
import { QUOTE_STALE_AFTER_MS } from '../../config/instrument';
import { useDisplayTimeZone } from '../../hooks/useDisplayTimeZone';
import { useActiveInstrument, useMarket } from '../../hooks/useMarket';
import { AI_ACTION_LABELS } from '../../services/ai/AiService';
import { getQuoteDisplayMode } from '../../services/market/normalize';
import { useNow } from '../../store/clock';
import { useStore } from '../../store/createStore';
import type { AiActionId, AiTab } from '../../types/ai';
import { formatHm24 } from '../../utils/format';
import { StatusPill } from '../ui/StatusPill';
import { Markdown } from './Markdown';
import './ai.css';

/** Phase 1: only Chat is real. The other modes are shown but not faked. */
const NOT_READY = 'Not available yet — Phase 1 is Chat only (read-only).';
const MARKET_LABEL: Record<string, { text: string; tone: string }> = {
  live: { text: 'Live', tone: 'is-ok' },
  delayed: { text: 'Delayed', tone: 'is-warn' },
  stale: { text: 'Stale', tone: 'is-warn' },
  connecting: { text: 'Not connected', tone: 'is-warn' },
  unavailable: { text: 'Not connected', tone: 'is-warn' },
};

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
  const { ai } = useServices();
  const state = useStore(ai.store, (s) => s);
  const instrument = useActiveInstrument();
  const market = useMarket((s) => s);
  const now = useNow('second');
  const tz = useDisplayTimeZone();
  const [tab, setTab] = useState<AiTab>('chat');
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const connected = state.status === 'CONNECTED';
  const marketMode = MARKET_LABEL[getQuoteDisplayMode(market, now, QUOTE_STALE_AFTER_MS)] ?? MARKET_LABEL.unavailable!;
  const intro = TAB_INTRO[tab];
  const chatTab = tab === 'chat';
  const lastRetry = [...state.messages].reverse().find((m) => m.role === 'system')?.retryOf ? [...state.messages].reverse().find((m) => m.role === 'system') : undefined;

  useEffect(() => ai.setInstrument(instrument.id), [ai, instrument.id]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, state.pending]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (state.pending || !draft.trim() || !chatTab) return; // no duplicate / blank / not-ready sends
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
          title={connected ? state.providerName ?? undefined : state.statusReason ?? 'No AI provider configured'}
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
          <button key={id} type="button" className="ai__action" onClick={() => void ai.runAction(tab, id)} disabled title={NOT_READY}>
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
          {!chatTab && (
            <p className="ai__offline" role="note" data-testid="ai-not-ready">
              {NOT_READY}
            </p>
          )}
          <dl className="ai__ws">
            <div>
              <dt>AI provider</dt>
              <dd className={connected ? 'is-ok' : 'is-warn'} data-testid="ai-provider-status" title={connected ? undefined : state.statusReason ?? undefined}>
                {connected ? 'Connected' : 'Not connected'}
              </dd>
            </div>
            <div>
              <dt>Instrument</dt>
              <dd className="is-ctx" data-testid="ai-instrument">{instrument.shortName}</dd>
            </div>
            <div>
              <dt>Market data</dt>
              <dd className={marketMode.tone} data-testid="ai-market-status">{marketMode.text}</dd>
            </div>
            <div>
              <dt>Engine access</dt>
              <dd className={state.contextAvailable ? 'is-ok' : 'is-off'} data-testid="ai-engine-access">{state.contextAvailable ? 'Read Only' : 'Disabled'}</dd>
            </div>
          </dl>
          {!connected && (
            <p className="ai__offline" role="note">
              Requests are not sent and no responses are generated until an AI provider is configured.
              {state.statusReason ? ` ${state.statusReason}` : ''}
            </p>
          )}
        </div>
        {state.messages.map((m) => (
          <div key={m.id} className={`ai__msg ai__msg--${m.role}${m.state === 'error' ? ' is-error' : ''}`}>
            <div className="ai__bubble">{m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}</div>
            {m.retryOf && m === lastRetry && !state.pending && (
              <button type="button" className="ai__retry" onClick={() => void ai.retry(tab)}>
                <RotateCcw size={12} /> Retry
              </button>
            )}
            <span className="ai__stamp num">{formatHm24(m.createdAt, tz)}</span>
          </div>
        ))}
        {state.pending && (
          <div className="ai__msg ai__msg--assistant" aria-busy="true">
            <div className="ai__bubble ai__thinking">Thinking…</div>
          </div>
        )}
      </div>

      <div className="ai__composer">
        <form className="ai__input" onSubmit={submit}>
          <label htmlFor="ai-input" className="sr-only">Message TLUXE AI</label>
          <input
            id="ai-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={chatTab ? `${intro.placeholder.replace('…', '')} (${instrument.shortName})…` : NOT_READY}
            autoComplete="off"
            disabled={!chatTab}
            maxLength={8000}
          />
          {state.pending ? (
            <button type="button" className="ai__send ai__stop" aria-label="Stop" title="Stop generating" onClick={() => ai.cancel()}>
              <Square size={14} />
            </button>
          ) : (
            <button type="submit" className="ai__send" aria-label="Send" disabled={!draft.trim() || !chatTab}>
              <Send size={16} />
            </button>
          )}
        </form>
        <p className="ai__foot">
          {connected ? `Model: ${state.providerName} · read-only` : 'Offline — messages are not sent while the AI provider is disconnected.'}
          {state.messages.length > 0 && (
            <button type="button" className="ai__clear" onClick={() => ai.clear()}>
              <Trash2 size={11} /> Clear conversation
            </button>
          )}
        </p>
      </div>
    </section>
  );
}
