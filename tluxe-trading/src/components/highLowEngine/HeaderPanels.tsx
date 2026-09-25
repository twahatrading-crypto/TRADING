import { Clock3 } from 'lucide-react';
import { useServices } from '../../app/servicesContext';
import { SESSIONS, UPCOMING_WINDOW_MS } from '../../config/sessions';
import type { HLEDecision } from '../../engines/highLowEngine/decision';
import type { HLESnapshot, StructureContext } from '../../engines/highLowEngine/types';
import { createStore, useStore } from '../../store/createStore';
import type { Mt5ProviderState } from '../../services/mt5/Mt5Provider';
import { formatPrice } from '../../utils/format';
import { formatCountdown, getSessionState } from '../../utils/sessions';
import { ago, fmtTime, useNow } from './useHighLow';

const biasTone = (b: string | undefined) => (b === 'BULLISH' ? 'buy' : b === 'BEARISH' ? 'sell' : 'neutral');

export function TopCards({ symbol, price, change, changePct, d, h4, h1, snap, decision }: { symbol: string; price: number | null; change: number | null; changePct: number | null; d: number; h4: StructureContext | null; h1: StructureContext | null; snap: HLESnapshot | null; decision: HLEDecision | null }) {
  const now = useNow();
  const open = SESSIONS.filter((s) => s.id !== 'globex').map((s) => ({ s, st: getSessionState(s, now, UPCOMING_WINDOW_MS) }));
  const live = open.filter((x) => x.st.status === 'OPEN');
  const next = [...open].sort((a, b) => a.st.next.open - b.st.next.open)[0]!;
  const levels = snap?.levels.filter((l) => l.retiredAt === null && l.state !== 'CONSUMED' && (l.source !== 'swing' || l.major)) ?? [];
  const nearest = price === null ? null : [...levels].sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0] ?? null;
  const confirmed = decision?.confirmed ? decision.direction : null;
  return (
    <div className="hlecards-top">
      <div className="panel hlecard-mini" data-testid="hle-price">
        <span className="hlecard-mini__k">{symbol}</span>
        <strong className="num hlecard-mini__price">{price === null ? '—' : formatPrice(price, d)}</strong>
        <span className={`num ${(change ?? 0) >= 0 ? 'up' : 'down'}`}>{change === null ? 'NO QUOTE' : `${change >= 0 ? '+' : ''}${formatPrice(change, d)} (${(changePct ?? 0).toFixed(2)}%)`}</span>
      </div>
      <div className="panel hlecard-mini" data-testid="hle-session">
        <span className="hlecard-mini__k">Current session</span>
        <strong><i className={`hledot ${live.length ? 'is-on' : ''}`} /> {live.length ? live.map((x) => x.s.name).join(' / ') : 'No main session'}</strong>
        <span className="hlecard-mini__sub">{live.length ? `ends in ${formatCountdown(live[0]!.st.countdownMs)}` : `${next.s.name} opens in ${formatCountdown(next.st.countdownMs)}`}</span>
      </div>
      <div className="panel hlecard-mini" data-testid="hle-h4bias">
        <span className="hlecard-mini__k">H4 direction</span>
        <span className={`hlepill hlepill--${biasTone(h4?.bias)}`}>{h4 ? (h4.bias === 'INSUFFICIENT_DATA' ? 'WAITING FOR DATA' : h4.bias) : 'NO DATA'}</span>
        <span className="hlecard-mini__sub">{h4 ? h4.reason : '—'}</span>
      </div>
      <div className="panel hlecard-mini" data-testid="hle-h1bias">
        <span className="hlecard-mini__k">H1 bias</span>
        <span className={`hlepill hlepill--${biasTone(h1?.bias)}`}>{h1 ? (h1.bias === 'INSUFFICIENT_DATA' ? 'WAITING FOR DATA' : h1.bias) : 'NO DATA'}</span>
        <span className="hlecard-mini__sub">{nearest && price !== null ? `${price < nearest.price ? 'Below' : 'Above'} ${nearest.label}` : '—'}</span>
      </div>
      <div className={`panel hlecard-mini hlecard-signal ${confirmed ? `is-${confirmed.toLowerCase()}` : ''}`} data-testid="hle-signal">
        <span className="hlecard-mini__k">Current signal</span>
        <strong className="hlecard-signal__v">{decision ? decision.label : 'NO DATA'}</strong>
        <span className="hlecard-mini__sub">{decision ? decision.why : 'No closed candles yet.'}</span>
      </div>
    </div>
  );
}

const CLOCKS = [
  { city: 'Denver', tz: 'America/Denver' },
  { city: 'India', tz: 'Asia/Kolkata' },
  { city: 'Malaysia', tz: 'Asia/Kuala_Lumpur' },
  { city: 'Myanmar', tz: 'Asia/Yangon' },
];
export function WorldClock() {
  const now = useNow();
  return (
    <div className="hleclocks" aria-label="World time">
      <span className="hleclocks__label"><Clock3 size={13} aria-hidden="true" /> WORLD TIME</span>
      {CLOCKS.map((c) => (
        <div className="panel hleclock" key={c.city} data-testid={`hle-clock-${c.city.toLowerCase()}`}>
          <span className="hleclock__city">{c.city.toUpperCase()}</span>
          <strong className="num">{new Intl.DateTimeFormat('en-US', { timeZone: c.tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h12' }).format(now)}</strong>
          <span className="hleclock__date">{new Intl.DateTimeFormat('en-US', { timeZone: c.tz, month: 'short', day: 'numeric', year: 'numeric' }).format(now)}</span>
        </div>
      ))}
    </div>
  );
}

/** Used only when no MT5 provider is configured (every field empty — shown as NOT CONFIGURED). */
const FALLBACK = createStore<Mt5ProviderState>({ attempted: false, heartbeatAt: null, bridgeVersion: null, startedAtMs: null, terminal: null, account: null as unknown as Mt5ProviderState['account'], time: null, error: null, symbolCount: null, resolutions: [], futuresCandidates: [], lastDiscoveryAt: null, reconnects: 0 });
const BRIDGE_FRESH_MS = 10_000;

/** Engine Status — every value from a real source; nothing is simulated. */
export function EngineStatus({ computedAt, tz }: { computedAt: number | null; tz: string }) {
  const { mt5 } = useServices();
  const now = useNow();
  const st = useStore(mt5?.state ?? FALLBACK, (s) => s);
  const bridgeUp = !!mt5 && st.heartbeatAt !== null && now - st.heartbeatAt < BRIDGE_FRESH_MS && !st.error;
  const terminalUp = bridgeUp && st.terminal?.state === 'CONNECTED';
  const cell = (k: string, v: string, tone: 'ok' | 'bad' | 'muted', sub?: string, testId?: string) => (
    <div className="hlestatus__cell" data-testid={testId}>
      <span className="hlestatus__k">{k}</span>
      <strong className={`hlestatus__v is-${tone}`}>{v}</strong>
      {sub && <span className="hlestatus__sub">{sub}</span>}
    </div>
  );
  return (
    <section className="panel hlestatus" aria-label="Engine status">
      <span className="hlestatus__title">ENGINE STATUS <em>read-only</em></span>
      {cell('MT5', !mt5 ? 'NOT CONFIGURED' : terminalUp ? 'CONNECTED' : 'OFFLINE', terminalUp ? 'ok' : mt5 ? 'bad' : 'muted', undefined, 'hle-status-mt5')}
      {cell('Runner', 'NOT CONFIGURED', 'muted', 'analysis runs in this browser tab', 'hle-status-runner')}
      {cell('Bridge', !mt5 ? 'NOT CONFIGURED' : bridgeUp ? 'RUNNING' : 'OFFLINE', bridgeUp ? 'ok' : mt5 ? 'bad' : 'muted', mt5 ? `heartbeat ${ago(st.heartbeatAt, now)}` : 'set it up in Settings', 'hle-status-bridge')}
      {cell('Automatic email', 'OFF', 'muted', 'no mail service configured', 'hle-status-email')}
      {cell('Email authority', 'NONE', 'muted')}
      {cell('Last runner heartbeat', '—', 'muted', 'no server-side runner')}
      {cell('Last analysis', computedAt === null ? '—' : fmtTime(computedAt / 1000, tz), computedAt === null ? 'muted' : 'ok', computedAt === null ? undefined : `(${ago(computedAt, now)})`, 'hle-status-analysis')}
    </section>
  );
}
