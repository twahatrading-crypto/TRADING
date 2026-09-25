import { describe, expect, it } from 'vitest';
import { DEFAULT_ORDER_FLOW_SETTINGS } from './config';
import { OrderFlowEngine } from './engine';
import { OrderFlowRecorder, OrderFlowReplay } from './replay';
import { FULL_CAPS, TEST_INSTRUMENT, TEST_TICK, demoSession, generatedSession } from './testing/scenarios';
import type { OrderFlowMsg } from './types';

/* TEST DATA ONLY. */

const opts = { instrumentId: TEST_INSTRUMENT, tickSize: TEST_TICK, capabilities: FULL_CAPS, settings: { ...DEFAULT_ORDER_FLOW_SETTINGS } };
const live = (msgs: readonly OrderFlowMsg[]) => {
  const e = new OrderFlowEngine(opts);
  e.processAll(msgs);
  return e;
};

function fakeTimers() {
  let now = 0;
  let cb: (() => void) | null = null;
  return {
    t: {
      setInterval: ((f: () => void) => ((cb = f), 1)) as unknown as typeof setInterval,
      clearInterval: (() => (cb = null)) as unknown as typeof clearInterval,
      now: () => now,
    },
    advance(ms: number) {
      for (let x = 0; x < ms; x += 50) {
        now += 50;
        cb?.();
      }
    },
    running: () => cb !== null,
  };
}

describe('order-flow replay parity', () => {
  it('replaying the whole recording equals the live run (book, heatmap, events, totals)', () => {
    for (const msgs of [demoSession(), generatedSession(3, 11)]) {
      const r = new OrderFlowReplay(msgs, opts);
      r.step(msgs.length);
      expect(r.engine.digest()).toBe(live(msgs).digest());
      expect(r.store.getState().cursor).toBe(msgs.length);
    }
  });

  it('chunked stepping equals one pass', () => {
    const msgs = demoSession();
    const r = new OrderFlowReplay(msgs, opts);
    while (r.store.getState().cursor < msgs.length) r.step(7);
    expect(r.engine.digest()).toBe(live(msgs).digest());
  });

  it('a partial replay equals the live engine at the same point (no look-ahead)', () => {
    const msgs = demoSession();
    const r = new OrderFlowReplay(msgs, opts);
    r.step(60);
    expect(r.engine.digest()).toBe(live(msgs.slice(0, 60)).digest());
  });

  it('jumpTo processes exactly the messages up to that exchange time; going back rebuilds identically', () => {
    const msgs = demoSession();
    const r = new OrderFlowReplay(msgs, opts);
    const t = msgs[80]!.exchTime;
    r.jumpTo(t);
    const n = msgs.filter((m) => m.exchTime <= t).length;
    expect(r.store.getState().cursor).toBe(n);
    expect(r.store.getState().time).toBe(t);
    const at = r.engine.digest();
    r.step(msgs.length);
    r.jumpTo(t); // backwards
    expect(r.engine.digest()).toBe(at);
    expect(at).toBe(live(msgs.slice(0, n)).digest());
  });

  it('reset returns to an empty engine and pauses', () => {
    const msgs = demoSession();
    const r = new OrderFlowReplay(msgs, opts);
    r.step(50);
    r.reset();
    expect(r.store.getState()).toMatchObject({ cursor: 0, time: null, playing: false });
    expect(r.engine.digest()).toBe(new OrderFlowEngine(opts).digest());
  });

  it('play advances in exchange time × speed and stops at the end', () => {
    const msgs = demoSession();
    const ft = fakeTimers();
    const r = new OrderFlowReplay(msgs, opts, ft.t);
    r.step(1); // snapshot at T0
    r.setSpeed(10);
    r.play();
    expect(r.store.getState().playing).toBe(true);
    ft.advance(1000); // 1 s wall × 10 = 10 s exchange time
    const t = r.store.getState().time!;
    expect(t - msgs[0]!.exchTime).toBeGreaterThanOrEqual(9_000);
    expect(t - msgs[0]!.exchTime).toBeLessThanOrEqual(10_050);
    r.pause();
    expect(r.store.getState().playing).toBe(false);
    const c = r.store.getState().cursor;
    ft.advance(1000);
    expect(r.store.getState().cursor).toBe(c);
    r.setSpeed(50);
    r.play();
    ft.advance(10_000);
    expect(r.store.getState().cursor).toBe(msgs.length);
    expect(r.store.getState().playing).toBe(false);
    expect(ft.running()).toBe(false);
    expect(r.engine.digest()).toBe(live(msgs).digest());
  });
});

describe('recorder (rolling buffer)', () => {
  it('is bounded and the retained part always restarts at a depth snapshot', () => {
    const rec = new OrderFlowRecorder(200);
    const msgs = generatedSession(2, 5);
    // Insert a snapshot periodically (as a resync would).
    msgs.forEach((m, i) => {
      rec.record(m);
      if (i % 150 === 0 && i > 0) rec.record({ ...(msgs[0] as Extract<OrderFlowMsg, { type: 'snapshot' }>), exchTime: m.exchTime, recvTime: m.recvTime, seq: m.type === 'depth' ? m.seq : null });
    });
    expect(rec.messages().length).toBeLessThanOrEqual(200);
    expect(rec.messages()[0]!.type).toBe('snapshot');
    rec.clear();
    expect(rec.messages()).toHaveLength(0);
  });
});
