import type { HLEFeed } from '../../engines/highLowEngine/decision';
import type { HLESnapshot, Setup } from '../../engines/highLowEngine/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentId } from '../../types/instruments';

type KV = Pick<Storage, 'getItem' | 'setItem'> | null;

export type DesktopPermission = 'granted' | 'denied' | 'default' | 'unsupported';
/** Structured alert kinds (never re-derived from display text, handoff §13 RISK). */
export type HLEAlertKind = 'entry-ready' | 'late-entry' | 'pre-entry' | 'pre-entry-late';
export type HLEDiscovery = 'outage' | 'startup' | 'delayed';
export interface HLEAlertRecord {
  kind: HLEAlertKind;
  alertKey: string;
  setupId: string;
  instrumentId: InstrumentId;
  side: 'BUY' | 'SELL';
  /** When it was raised (ms) and when the engine made it ready (ms: pullback close / M5 close). */
  at: number;
  readyAt: number;
  late: boolean;
  discovery: HLEDiscovery | null;
  entry: number | null;
  stop: number | null;
  tp1: number | null;
  channels: string[];
}
export interface AlertState {
  alarmOn: boolean;
  sound: 'armed' | 'off' | 'unsupported';
  desktop: DesktopPermission;
  /** No mailer exists in TLUXE: email is never faked. */
  email: 'not-configured';
  last: HLEAlertRecord | null;
  history: HLEAlertRecord[];
}

export interface AlertChannels {
  sound: ((kind: HLEAlertKind) => boolean) | null;
  desktop: ((title: string, body: string, tag: string) => boolean) | null;
  permission: () => DesktopPermission;
  now: () => number;
}

/** FRESH / LATE boundary — inclusive: exactly 5 minutes old is still fresh (handoff §14.2). */
export const ALERT_FRESH_MS = 5 * 60 * 1000;
export const ALERT_KEEP_MS = 14 * 24 * 3600 * 1000;
export const ALERT_MAX_STORED = 300;
const STORE_KEY = 'tluxe.hle.alerts.v2';
export const DISCOVERY_TEXT: Record<HLEDiscovery, string> = {
  outage: 'after a data outage / reconnect',
  startup: 'after a restart / start-up',
  delayed: 'confirmed more than 5 min after its entry time',
};

function browserChannels(): AlertChannels {
  const hasAudio = typeof window !== 'undefined' && typeof (window as unknown as { AudioContext?: unknown }).AudioContext === 'function';
  return {
    sound: hasAudio
      ? (kind) => {
          try {
            const ctx = new AudioContext();
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            // Siren for a fresh entry, soft chime for late, rising sweep for PRE-ENTRY.
            o.type = kind === 'entry-ready' ? 'square' : kind === 'late-entry' ? 'triangle' : 'sawtooth';
            o.frequency.value = kind === 'entry-ready' ? 980 : kind === 'late-entry' ? 523 : 440;
            if (kind.startsWith('pre')) o.frequency.linearRampToValueAtTime(880, ctx.currentTime + 0.4);
            g.gain.value = 0.08;
            o.connect(g).connect(ctx.destination);
            o.start();
            o.stop(ctx.currentTime + 0.45);
            return true;
          } catch {
            return false;
          }
        }
      : null,
    desktop:
      typeof Notification !== 'undefined'
        ? (title, body, tag) => {
            try {
              if (Notification.permission !== 'granted') return false;
              new Notification(title, { body, tag });
              return true;
            } catch {
              return false;
            }
          }
        : null,
    permission: () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission),
    now: () => Date.now(),
  };
}

interface Persisted {
  entry: Record<string, number>;
  pre: Record<string, number>;
}

/**
 * High / Low Engine alert policy (handoff §14, contract H) — a LISTENER only: it never computes a
 * market value and never changes the engine result.
 *  • ENTRY: every unique setup (keyed on its M5 break candle) alerts exactly ONCE, fresh or late.
 *    Age at first sight ≤ 5 min → ENTRY READY; older → LATE ENTRY DISCOVERED with discovery
 *    outage (made ready before the last reconnect) / startup (before the first live data) / delayed.
 *  • Only on a LIVE feed: an outage still in progress raises nothing.
 *  • The id is RECORDED (persisted) BEFORE any channel fires, so nothing can alarm twice.
 *  • PRE-ENTRY: separate store and key, M5 confirmed + zone waiting for the pullback; age from the
 *    M5 close; never after (or instead of) that setup's ENTRY alert.
 *  • Channels are independent; the mute switch silences only the sound. Email: not configured.
 */
export class HighLowAlerts {
  readonly store: Store<AlertState>;
  private readonly ch: AlertChannels;
  private data: Persisted = { entry: {}, pre: {} };
  private readonly clocks = new Map<InstrumentId, { everLive: boolean; wasLive: boolean | null; firstLiveAt: number | null; recoveredAt: number | null }>();

  constructor(
    private readonly storage: KV,
    channels?: Partial<AlertChannels>,
  ) {
    this.ch = { ...browserChannels(), ...channels };
    let alarmOn = true;
    try {
      alarmOn = this.storage?.getItem('tluxe.hle.alarm.v1') !== 'off';
      const raw = this.storage?.getItem(STORE_KEY);
      const p = raw ? (JSON.parse(raw) as Persisted) : null;
      if (p && typeof p === 'object') this.data = { entry: p.entry ?? {}, pre: p.pre ?? {} };
    } catch {
      /* defaults */
    }
    this.store = createStore<AlertState>({ alarmOn, sound: this.ch.sound ? (alarmOn ? 'armed' : 'off') : 'unsupported', desktop: this.ch.permission(), email: 'not-configured', last: null, history: [] });
  }

  setAlarm(on: boolean): void {
    try {
      this.storage?.setItem('tluxe.hle.alarm.v1', on ? 'on' : 'off');
    } catch {
      /* preference only */
    }
    this.store.setState({ alarmOn: on, sound: this.ch.sound ? (on ? 'armed' : 'off') : 'unsupported' });
  }

  async requestDesktop(): Promise<void> {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission();
    this.store.setState({ desktop: this.ch.permission() });
  }

  testAlarm(): boolean {
    const ok = this.ch.sound?.('entry-ready') ?? false;
    this.ch.desktop?.('TLUXE · test alarm', 'High / Low Engine test notification (no signal).', 'hle-test');
    return ok;
  }

  private persist(): void {
    const now = this.ch.now();
    for (const map of [this.data.entry, this.data.pre]) {
      const keys = Object.keys(map).sort((a, b) => map[a]! - map[b]!);
      for (const k of keys) if (now - map[k]! > ALERT_KEEP_MS) delete map[k];
      const rest = Object.keys(map).sort((a, b) => map[a]! - map[b]!);
      for (const k of rest.slice(0, Math.max(0, rest.length - ALERT_MAX_STORED))) delete map[k];
    }
    try {
      this.storage?.setItem(STORE_KEY, JSON.stringify(this.data));
    } catch {
      /* in-memory de-dup still applies for this session */
    }
  }

  /** Observe the engine result for one instrument together with the feed state. Returns the records raised now. */
  observe(id: InstrumentId, snap: HLESnapshot | null, feed: HLEFeed): HLEAlertRecord[] {
    const at = this.ch.now();
    const live = feed === 'LIVE' && snap?.state === 'READY';
    // The three clocks are maintained before any early return (handoff §14.2).
    const c = this.clocks.get(id) ?? { everLive: false, wasLive: null, firstLiveAt: null, recoveredAt: null };
    if (live) {
      if (c.everLive && c.wasLive === false) c.recoveredAt = at;
      if (!c.everLive) {
        c.everLive = true;
        c.firstLiveAt = at;
      }
    }
    c.wasLive = live;
    this.clocks.set(id, c);
    if (!live || !snap) return [];

    const raised: HLEAlertRecord[] = [];
    const seen = new Set<string>();
    const sorted = [...snap.setups].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const s of sorted) {
      if (s.state !== 'ENTRY_READY' || !s.alertKey || !s.risk || !s.entry || seen.has(s.alertKey)) continue;
      seen.add(s.alertKey);
      if (this.data.entry[s.alertKey] !== undefined) continue;
      const readyAt = s.entry.knownAt * 1000;
      const late = at - readyAt > ALERT_FRESH_MS;
      const discovery: HLEDiscovery | null = !late ? null : c.recoveredAt !== null && readyAt < c.recoveredAt ? 'outage' : c.firstLiveAt !== null && readyAt < c.firstLiveAt ? 'startup' : 'delayed';
      this.data.entry[s.alertKey] = at;
      this.persist(); // record BEFORE any channel fires
      raised.push(this.raise(late ? 'late-entry' : 'entry-ready', s, id, at, readyAt, late, discovery));
    }
    for (const s of sorted) {
      if (s.state !== 'WAITING_M1' || !s.alertKey || !s.m5 || !s.zone || s.entry || seen.has(s.alertKey)) continue;
      seen.add(s.alertKey);
      if (this.data.pre[s.alertKey] !== undefined || this.data.entry[s.alertKey] !== undefined) continue;
      const readyAt = s.m5.knownAt * 1000;
      const late = at - readyAt > ALERT_FRESH_MS;
      this.data.pre[s.alertKey] = at;
      this.persist();
      raised.push(this.raise(late ? 'pre-entry-late' : 'pre-entry', s, id, at, readyAt, late, late ? (c.recoveredAt !== null && readyAt < c.recoveredAt ? 'outage' : c.firstLiveAt !== null && readyAt < c.firstLiveAt ? 'startup' : 'delayed') : null));
    }
    return raised;
  }

  private raise(kind: HLEAlertKind, s: Setup, id: InstrumentId, at: number, readyAt: number, late: boolean, discovery: HLEDiscovery | null): HLEAlertRecord {
    const title =
      kind === 'entry-ready'
        ? `🚨 ENTRY READY — ${s.side}`
        : kind === 'late-entry'
          ? `⚠️ LATE ENTRY DISCOVERED — ${s.side}`
          : kind === 'pre-entry'
            ? `⚠️ PRE-ENTRY — GET READY (${s.side})`
            : `⚠️ PRE-ENTRY DISCOVERED LATE (${s.side})`;
    const body = s.risk
      ? `${id} entry ${s.risk.entry.toFixed(5).replace(/0+$/, '')} · SL ${s.risk.stop.toFixed(5).replace(/0+$/, '')} · TP1 ${s.risk.tp1.toFixed(5).replace(/0+$/, '')}${discovery ? ` · not fresh: ${DISCOVERY_TEXT[discovery]}` : ''}`
      : `${id} M5 ${s.m5?.kind} confirmed · zone ${s.zone?.low.toFixed(5).replace(/0+$/, '')} – ${s.zone?.high.toFixed(5).replace(/0+$/, '')} · waiting for the M1 pullback (not a signal)`;
    const channels: string[] = [];
    // Independent channels: one failing never stops the others; mute silences only the sound.
    try {
      if (this.store.getState().alarmOn && this.ch.sound?.(kind)) channels.push('sound');
    } catch {
      /* sound failed alone */
    }
    try {
      if (this.ch.desktop?.(`TLUXE · ${title}`, body, s.alertKey!)) channels.push('desktop');
    } catch {
      /* notification failed alone */
    }
    channels.push('banner');
    const rec: HLEAlertRecord = { kind, alertKey: s.alertKey!, setupId: s.id, instrumentId: id, side: s.side, at, readyAt, late, discovery, entry: s.risk?.entry ?? null, stop: s.risk?.stop ?? s.zone?.stop ?? null, tp1: s.risk?.tp1 ?? null, channels };
    this.store.setState({ last: rec, history: [rec, ...this.store.getState().history].slice(0, 50) });
    return rec;
  }
}
