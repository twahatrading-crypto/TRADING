import type { HLESnapshot } from '../../engines/highLowEngine/types';
import { createStore, type Store } from '../../store/createStore';
import type { InstrumentId } from '../../types/instruments';

type KV = Pick<Storage, 'getItem' | 'setItem'> | null;

export type DesktopPermission = 'granted' | 'denied' | 'default' | 'unsupported';
export interface AlertState {
  alarmOn: boolean;
  sound: 'armed' | 'off' | 'unsupported';
  desktop: DesktopPermission;
  /** No mailer exists in TLUXE: email is never faked. */
  email: 'not-configured';
  last: { setupId: string; side: 'BUY' | 'SELL'; at: number; channels: string[] } | null;
}

export interface AlertChannels {
  sound: (() => boolean) | null;
  desktop: ((title: string, body: string) => boolean) | null;
  permission: () => DesktopPermission;
  now: () => number;
}

/** Alerts only for ENTRY_READY that happened within this window (never for history on load). */
export const ALERT_FRESH_MS = 10 * 60 * 1000;

function browserChannels(): AlertChannels {
  const hasAudio = typeof window !== 'undefined' && typeof (window as unknown as { AudioContext?: unknown }).AudioContext === 'function';
  return {
    sound: hasAudio
      ? () => {
          try {
            const ctx = new AudioContext();
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.frequency.value = 880;
            g.gain.value = 0.08;
            o.connect(g).connect(ctx.destination);
            o.start();
            o.stop(ctx.currentTime + 0.35);
            return true;
          } catch {
            return false;
          }
        }
      : null,
    desktop:
      typeof Notification !== 'undefined'
        ? (title, body) => {
            try {
              if (Notification.permission !== 'granted') return false;
              new Notification(title, { body });
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

/**
 * ENTRY alerts: fire exactly once per setup, only on a transition INTO ENTRY_READY observed
 * live (the first snapshot per instrument only seeds what is already ready), only when that
 * ENTRY_READY is fresh, and never again for the same setup (persisted across refresh / HMR).
 */
export class HighLowAlerts {
  readonly store: Store<AlertState>;
  private readonly seeded = new Set<InstrumentId>();
  private readonly ready = new Map<InstrumentId, Set<string>>();
  private readonly alerted: Set<string>;
  private readonly ch: AlertChannels;

  constructor(
    private readonly storage: KV,
    channels?: Partial<AlertChannels>,
  ) {
    this.ch = { ...browserChannels(), ...channels };
    let alarmOn = true;
    let alerted: string[] = [];
    try {
      alarmOn = this.storage?.getItem('tluxe.hle.alarm.v1') !== 'off';
      const raw = this.storage?.getItem('tluxe.hle.alerted.v1');
      alerted = raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      /* defaults */
    }
    this.alerted = new Set(Array.isArray(alerted) ? alerted : []);
    this.store = createStore<AlertState>({ alarmOn, sound: this.ch.sound ? (alarmOn ? 'armed' : 'off') : 'unsupported', desktop: this.ch.permission(), email: 'not-configured', last: null });
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
    const ok = this.ch.sound?.() ?? false;
    this.ch.desktop?.('TLUXE · test alarm', 'High / Low Engine test notification (no signal).');
    return ok;
  }

  /** Observe a new snapshot; returns the setups that alerted now. */
  observe(id: InstrumentId, snap: HLESnapshot | null): string[] {
    if (!snap) return [];
    const nowReady = new Set(snap.setups.filter((s) => s.state === 'ENTRY_READY').map((s) => s.id));
    if (!this.seeded.has(id)) {
      this.seeded.add(id);
      this.ready.set(id, nowReady);
      return [];
    }
    const before = this.ready.get(id) ?? new Set<string>();
    this.ready.set(id, nowReady);
    const fired: string[] = [];
    for (const s of snap.setups) {
      if (s.state !== 'ENTRY_READY' || before.has(s.id) || this.alerted.has(s.id)) continue;
      if (this.ch.now() - s.entry!.knownAt * 1000 > ALERT_FRESH_MS) continue;
      this.alerted.add(s.id);
      fired.push(s.id);
      const channels: string[] = [];
      if (this.store.getState().alarmOn) {
        if (this.ch.sound?.()) channels.push('sound');
        if (this.ch.desktop?.(`TLUXE · ${s.side} CONFIRMED`, `${id} entry ${s.risk!.entry} · SL ${s.risk!.stop}${s.risk!.tp1 !== null ? ` · TP1 ${s.risk!.tp1}` : ''}`)) channels.push('desktop');
      }
      this.store.setState({ last: { setupId: s.id, side: s.side, at: s.entry!.knownAt, channels } });
    }
    if (fired.length) {
      try {
        this.storage?.setItem('tluxe.hle.alerted.v1', JSON.stringify([...this.alerted].slice(-500)));
      } catch {
        /* in-memory de-dup still applies */
      }
    }
    return fired;
  }
}
