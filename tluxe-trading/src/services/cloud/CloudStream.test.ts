import { describe, expect, it } from 'vitest';
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, backoffMs, CloudStream, streamUrl, type StreamMessage } from './CloudStream';

/** TEST transport: a scripted socket + a manual clock (no network, no real timers). */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }
  open() {
    this.onopen?.({});
  }
  msg(type: string, seq: number, data: unknown = {}) {
    this.onmessage?.({ data: JSON.stringify({ type, seq, ts: 0, data }) });
  }
  drop() {
    this.closed = true;
    this.onclose?.({});
  }
}

function harness(o: { heartbeatS?: number } = {}) {
  FakeSocket.all = [];
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  const events = { messages: [] as StreamMessage[], resync: [] as string[], rejected: 0 };
  const s = new CloudStream({
    url: 'wss://tluxe.example.app/api/stream',
    channels: ['status', 'news'],
    heartbeatS: o.heartbeatS ?? 15,
    socket: (u) => new FakeSocket(u),
    now: () => now,
    random: () => 1,
    setTimer: (fn, ms) => {
      timers.push({ at: now + ms, fn, id: ++id });
      return id;
    },
    clearTimer: (t) => {
      const i = timers.findIndex((x) => x.id === t);
      if (i >= 0) timers.splice(i, 1);
    },
    onMessage: (m) => events.messages.push(m),
    onResync: (why) => events.resync.push(why),
    onRejected: () => events.rejected++,
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };
  const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;
  return { s, events, advance, last };
}

describe('CloudStream - real-time transport to the gateway', () => {
  it('uses WSS on an HTTPS page and WS only on plain HTTP (local dev)', () => {
    expect(streamUrl({ protocol: 'https:', host: 'tluxe.example.app' })).toBe('wss://tluxe.example.app/api/stream');
    expect(streamUrl({ protocol: 'http:', host: 'localhost:5182' })).toBe('ws://localhost:5182/api/stream');
  });

  it('back-off grows exponentially, is capped and jittered', () => {
    expect(backoffMs(0, () => 1)).toBe(BACKOFF_MIN_MS);
    expect(backoffMs(3, () => 1)).toBe(8 * BACKOFF_MIN_MS);
    expect(backoffMs(30, () => 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(3, () => 0)).toBe(4 * BACKOFF_MIN_MS);
  });

  it('connects, subscribes, delivers data and resyncs on connect', () => {
    const { s, events, last } = harness();
    s.start();
    expect(s.store.getState().state).toBe('CONNECTING');
    last().open();
    expect(last().sent).toEqual([{ type: 'subscribe', channels: ['status', 'news'] }]);
    last().msg('hello', 1, { heartbeatS: 15 });
    last().msg('status', 2, { timeMs: 1 });
    expect(s.store.getState().state).toBe('LIVE');
    expect(events.resync).toEqual(['connected']);
    expect(events.messages.map((m) => m.type)).toEqual(['status']); // hello / heartbeat are transport only
  });

  it('a sequence gap triggers a resync; duplicates / replays are ignored', () => {
    const { s, events, last } = harness();
    s.start();
    last().open();
    last().msg('hello', 1);
    last().msg('status', 2);
    last().msg('status', 2); // duplicate
    last().msg('status', 1); // replay
    last().msg('status', 5); // gap (3, 4 lost)
    expect(events.messages.map((m) => m.seq)).toEqual([2, 5]);
    expect(events.resync).toEqual(['connected', 'gap']);
    expect(s.store.getState().gaps).toBe(1);
  });

  it('reconnects with back-off after the connection drops, then resumes', () => {
    const { s, events, advance, last } = harness();
    s.start();
    last().open();
    last().msg('hello', 1);
    last().drop();
    expect(s.store.getState().state).toBe('RECONNECTING');
    advance(BACKOFF_MIN_MS - 1);
    expect(FakeSocket.all).toHaveLength(1);
    advance(1);
    expect(FakeSocket.all).toHaveLength(2);
    last().open();
    last().msg('hello', 1); // new connection numbers from 1 again
    expect(s.store.getState()).toMatchObject({ state: 'LIVE', connects: 2 });
    expect(events.resync).toEqual(['connected', 'connected']);
  });

  it('silence longer than 2.5 heartbeats marks the stream STALE and forces a reconnect', () => {
    const { s, advance, last } = harness({ heartbeatS: 10 });
    s.start();
    last().open();
    last().msg('hello', 1, { heartbeatS: 10 });
    advance(20_000);
    last().msg('heartbeat', 2); // heartbeat keeps it alive
    advance(24_000);
    expect(s.store.getState().state).toBe('LIVE');
    advance(1_001);
    expect(s.store.getState().state).toBe('STALE');
    expect(FakeSocket.all[0]!.closed).toBe(true);
    advance(BACKOFF_MIN_MS);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('a socket that closes before opening (e.g. expired session) is reported and backs off further each time', () => {
    const { s, events, advance, last } = harness();
    s.start();
    last().drop();
    advance(BACKOFF_MIN_MS);
    last().drop();
    expect(events.rejected).toBe(2);
    advance(BACKOFF_MIN_MS);
    expect(FakeSocket.all).toHaveLength(2); // second wait is 2 s
    advance(BACKOFF_MIN_MS);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('stop() closes the socket and never reconnects', () => {
    const { s, advance, last } = harness();
    s.start();
    last().open();
    s.stop();
    advance(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(s.store.getState().state).toBe('STOPPED');
  });
});
