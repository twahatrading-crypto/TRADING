import { OfpEngine } from '../../engines/orderFlowPro/engine';
import { OFP_ROOTS } from '../../engines/orderFlowPro/config';
import type { OfpFrame, OfpRoot } from '../../engines/orderFlowPro/types';
import { BackendSource } from './BackendSource';
import type { OfpSource } from './source';

/* ============================================================================
 * Order Flow Pro controller - a module singleton OUTSIDE React (HMR-safe, StrictMode-safe):
 *   - one engine per root, one ref-counted source subscription per root (a second acquire() never opens a second
 *     poll chain; the last release() stops it);
 *   - notifications are coalesced to at most one per animation frame;
 *   - replay runs a SEPARATE engine fed from recorded history, so live state is never altered by replay.
 * Owns nothing shared with any other TLUXE engine or provider.
 * ========================================================================== */

export interface ReplayState {
  root: OfpRoot;
  engine: OfpEngine;
  from: number;
  to: number;
  cursor: number;
  speed: number;
  playing: boolean;
}

type Listener = () => void;

export class OfpController {
  readonly engines: Record<OfpRoot, OfpEngine>;
  private refs = new Map<OfpRoot, { count: number; stop: () => void }>();
  private listeners = new Set<Listener>();
  private pending = false;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private replayFrames: OfpFrame[] = [];
  private replayIdx = 0;
  replay: ReplayState | null = null;
  tick = 0;

  constructor(private src: OfpSource, readonly allowDemo = false) {
    if (src.info.demo && !allowDemo) throw new Error('DEMO source refused outside the dev harness / tests');
    this.engines = Object.fromEntries(OFP_ROOTS.map((r) => [r, new OfpEngine(r)])) as Record<OfpRoot, OfpEngine>;
  }

  get source() {
    return this.src;
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify = () => {
    if (this.pending) return;
    this.pending = true;
    const fire = () => {
      this.pending = false;
      this.tick++;
      for (const l of this.listeners) l();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fire);
    else setTimeout(fire, 16);
  };

  acquire(root: OfpRoot): () => void {
    const ex = this.refs.get(root);
    if (ex) ex.count++;
    else {
      const e = this.engines[root];
      const stop = this.src.subscribe(root, {
        frames: (fs) => {
          for (const f of fs) e.apply(f);
          this.notify();
        },
        status: (s) => {
          e.setStatus(s, s.lastEventMs ?? e.now ?? Date.now());
          this.notify();
        },
        time: (now) => {
          e.advance(now);
          this.notify();
        },
        reset: (reason) => {
          e.reset();
          e.noteResync(reason);
          this.notify();
        },
      });
      this.refs.set(root, { count: 1, stop });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const r = this.refs.get(root);
      if (!r) return;
      if (--r.count <= 0) {
        r.stop();
        this.refs.delete(root);
      }
    };
  }

  activeSubscriptions(): OfpRoot[] {
    return [...this.refs.keys()];
  }

  /** Start replay of recorded frames [from, to]: everything before `from` is applied instantly, then played. */
  async startReplay(root: OfpRoot, from: number, to: number, speed = 10) {
    this.stopReplay();
    const frames = await this.src.history(root, from, to);
    const engine = new OfpEngine(root, this.engines[root].status);
    const t0 = (f: OfpFrame) => {
      const e = f.events[0];
      return e ? ('t' in e ? e.t : e.from) : 0;
    };
    let i = 0;
    while (i < frames.length && t0(frames[i]!) < from) engine.apply(frames[i++]!);
    engine.advance(from);
    this.replayFrames = frames;
    this.replayIdx = i;
    this.replay = { root, engine, from, to, cursor: from, speed, playing: true };
    this.replayTimer = setInterval(() => this.replayStep(), 100);
    this.notify();
  }

  private replayStep() {
    const r = this.replay;
    if (!r || !r.playing) return;
    r.cursor = Math.min(r.to, r.cursor + 100 * r.speed);
    while (this.replayIdx < this.replayFrames.length) {
      const f = this.replayFrames[this.replayIdx]!;
      const e = f.events[0];
      const t = e ? ('t' in e ? e.t : e.from) : 0;
      if (t > r.cursor) break;
      r.engine.apply(f);
      this.replayIdx++;
    }
    r.engine.advance(r.cursor);
    if (r.cursor >= r.to) r.playing = false;
    this.notify();
  }

  setReplayPlaying(p: boolean) {
    if (this.replay) {
      this.replay.playing = p;
      this.notify();
    }
  }

  setReplaySpeed(s: number) {
    if (this.replay) {
      this.replay.speed = s;
      this.notify();
    }
  }

  stopReplay() {
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.replayTimer = null;
    this.replayFrames = [];
    this.replay = null;
    this.notify();
  }

  dispose() {
    this.stopReplay();
    for (const r of this.refs.values()) r.stop();
    this.refs.clear();
    this.listeners.clear();
  }
}

let current: OfpController | null = null;

/** The page's controller. Production: the local backend source. */
export function ofpController(): OfpController {
  if (!current) current = new OfpController(new BackendSource());
  return current;
}

/** Dev harness / tests only: install a different source (DEMO allowed only with allowDemo). */
export function installOfpController(c: OfpController) {
  current?.dispose();
  current = c;
}

if (import.meta.hot) import.meta.hot.dispose(() => current?.dispose());
