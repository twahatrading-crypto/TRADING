import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { validateCandles } from '../market/integrity';
import { DEFAULT_MT5_CONFIG, loadMt5Config, sanitizeMt5Config, saveMt5Config, MT5_CONFIG_KEY } from './config';
import { connectionOf, freshnessCode, type FreshnessInput } from './freshness';
import { barToCandle, invertCandle } from './normalizeMt5';
import type { BridgeBar } from './protocol';
import { memoryStorage } from '../../test/providers';

const H1 = 3600;
// Wed 2026-09-23 12:00:00 UTC
const WED = Date.UTC(2026, 8, 23, 12) / 1000;

const c = (time: number, o = 100, h = 101, l = 99, cl = 100.5, extra: Partial<Candle> = {}): Candle => ({ time, open: o, high: h, low: l, close: cl, volume: null, ...extra });

describe('candle integrity', () => {
  const opts = { tfSeconds: H1, nowSec: WED + H1 };

  it('quarantines malformed candles with a reason, never repairing them', () => {
    const bad = [
      c(WED, NaN),
      c(WED + H1, 100, 99, 101, 100), // high < low
      c(WED + 2 * H1, 0, 1, 0, 1), // non-positive
      c(WED + 3 * H1, 102, 101, 99, 100), // open outside
      c(WED + 4 * H1, 100, 101, 99, 105), // close outside
      c(1.5, 100, 101, 99, 100), // invalid timestamp
      c(WED + 100 * H1), // future
      c(WED - H1, 100, 101, 99, 100, { tickVolume: -1 }),
    ];
    const { candles, report } = validateCandles(bad, opts);
    expect(candles).toEqual([]);
    expect(report.quarantined.map((q) => q.reason)).toEqual([
      'non-finite',
      'high-below-low',
      'non-positive-price',
      'open-outside-range',
      'close-outside-range',
      'invalid-timestamp',
      'future-timestamp',
      'negative-volume',
    ]);
  });

  it('keeps exact duplicates once and drops both sides of a conflicting duplicate', () => {
    const { candles, report } = validateCandles([c(WED - 2 * H1), c(WED - 2 * H1), c(WED - H1), c(WED - H1, 100, 102, 99, 101)], opts);
    expect(candles.map((x) => x.time)).toEqual([WED - 2 * H1]);
    expect(report.exactDuplicates).toBe(1);
    expect(report.quarantined.map((q) => q.reason)).toEqual(['conflicting-duplicate']);
  });

  it('sorts out-of-order bars and reports it', () => {
    const { candles, report } = validateCandles([c(WED), c(WED - 2 * H1), c(WED - H1)], opts);
    expect(candles.map((x) => x.time)).toEqual([WED - 2 * H1, WED - H1, WED]);
    expect(report.outOfOrder).toBe(2);
  });

  it('reports intraday gaps and flags weekend gaps as expected', () => {
    const fri = Date.UTC(2026, 8, 18, 20) / 1000;
    const mon = Date.UTC(2026, 8, 21, 0) / 1000;
    const { report } = validateCandles([c(fri), c(mon), c(WED), c(WED + 4 * H1)], { tfSeconds: H1, nowSec: WED + 10 * H1 });
    expect(report.gaps).toHaveLength(3);
    expect(report.gaps[0]!.weekend).toBe(true);
    expect(report.gaps[2]).toMatchObject({ after: WED, before: WED + 4 * H1, missingBars: 3, weekend: false });
  });
});

describe('MT5 bar normalisation', () => {
  const bar: BridgeBar = { t: WED, st: WED + 3 * 3600, o: 2650.1, h: 2655.2, l: 2648.3, c: 2651.4, tv: 1834, rv: null, sp: 12, closed: true };
  const ctx = { instrumentId: 'XAUUSD', providerSymbol: 'XAUUSD.m', timeframe: 'H1' as const };

  it('uses the UTC time, keeps server time, and leaves missing real volume null (never 0, never tick volume)', () => {
    const k = barToCandle(bar, ctx);
    expect(k).toMatchObject({ time: WED, sourceTime: WED + 3 * 3600, open: 2650.1, high: 2655.2, low: 2648.3, close: 2651.4 });
    expect(k.volume).toBeNull();
    expect(k.realVolume).toBeNull();
    expect(k.tickVolume).toBe(1834);
    expect(k).toMatchObject({ spread: 12, source: 'mt5', isClosed: true, instrumentId: 'XAUUSD', providerSymbol: 'XAUUSD.m', timeframe: 'H1' });
  });

  it('keeps real volume when the broker supplies it', () => {
    expect(barToCandle({ ...bar, rv: 42 }, ctx)).toMatchObject({ volume: 42, realVolume: 42 });
  });

  it('marks the forming bar as not closed', () => {
    expect(barToCandle({ ...bar, closed: false }, ctx).isClosed).toBe(false);
  });

  it('inverts reciprocal candles with high/low swapped and drops the spread', () => {
    const inv = invertCandle(barToCandle({ ...bar, o: 0.8, h: 1, l: 0.5, c: 0.625 }, ctx));
    expect(inv).toMatchObject({ open: 1.25, high: 2, low: 1, close: 1.6, spread: null });
  });
});

describe('MT5 freshness', () => {
  const t = DEFAULT_MT5_CONFIG;
  const now = WED * 1000;
  const base: FreshnessInput = {
    now,
    heartbeatAt: now - 1000,
    attempted: true,
    terminalState: 'CONNECTED',
    marketOpen: true,
    lastQuoteAt: now - 2000,
    lastCandleAt: now - 30_000,
    candleTfSec: 60,
    maxClosedBars: 5000,
  };

  it('is LIVE only when every freshness input is fresh', () => {
    expect(freshnessCode(base, t)).toBe('LIVE');
    expect(connectionOf('LIVE')).toBe('LIVE');
  });

  it.each<[Partial<FreshnessInput>, string]>([
    [{ heartbeatAt: null, attempted: false }, 'MT5_CONNECTING'],
    [{ heartbeatAt: null }, 'MT5_BRIDGE_OFFLINE'],
    [{ heartbeatAt: now - 60_000 }, 'MT5_BRIDGE_OFFLINE'],
    [{ terminalState: 'NOT_RUNNING' }, 'MT5_NOT_RUNNING'],
    [{ terminalState: 'DISCONNECTED' }, 'ERROR'],
    [{ marketOpen: false, lastQuoteAt: now - 48 * 3600_000 }, 'MARKET_CLOSED'],
    [{ lastQuoteAt: null }, 'MT5_CONNECTED'],
    [{ lastQuoteAt: now - 5 * 60_000 }, 'STALE'],
    [{ lastCandleAt: now - 10 * 60_000 }, 'STALE'],
    [{ maxClosedBars: 10 }, 'INSUFFICIENT_HISTORY'],
  ])('%o → %s', (patch, code) => {
    expect(freshnessCode({ ...base, ...patch }, t)).toBe(code);
  });

  it('never maps stale, offline or closed states to LIVE', () => {
    for (const code of ['STALE', 'MT5_BRIDGE_OFFLINE', 'MT5_NOT_RUNNING', 'MARKET_CLOSED', 'ERROR'] as const) expect(connectionOf(code)).toBe('DISCONNECTED');
    expect(connectionOf('SYMBOL_NOT_FOUND')).toBe('UNAVAILABLE');
    expect(connectionOf('MT5_CONNECTED')).toBe('CONNECTING');
  });
});

describe('MT5 config', () => {
  it('defaults to disabled, local-only, no token', () => {
    expect(loadMt5Config(memoryStorage())).toMatchObject({ enabled: false, bridgeUrl: 'http://127.0.0.1:8765', token: '' });
  });

  it('sanitises values and round-trips through storage', () => {
    const s = memoryStorage();
    saveMt5Config(s, sanitizeMt5Config({ enabled: true, bridgeUrl: 'http://192.168.1.5:8765/', token: ' x ', historyBars: 10_000_000, overrides: { XAUUSD: { symbol: 'GOLD.pro' }, bad: { symbol: '' } } }));
    const cfg = loadMt5Config(s);
    expect(cfg).toMatchObject({ enabled: true, bridgeUrl: 'http://192.168.1.5:8765', token: 'x', historyBars: 50000, overrides: { XAUUSD: { symbol: 'GOLD.pro', inverted: false } } });
    expect(JSON.parse(s.getItem(MT5_CONFIG_KEY)!).overrides.bad).toBeUndefined();
  });

  it('rejects a non-http URL', () => {
    expect(sanitizeMt5Config({ bridgeUrl: 'javascript:alert(1)' }).bridgeUrl).toBe('http://127.0.0.1:8765');
  });
});

describe('Mt5BridgeClient', () => {
  it('sends the token only as a Bearer header and maps failures', async () => {
    const { Mt5BridgeClient, BridgeOfflineError, BridgeResponseError } = await import('./client');
    const seen: { url: string; auth: string | null }[] = [];
    const ok = new Mt5BridgeClient('http://127.0.0.1:8765', 'secret-token', 1000, async (url, init) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization') });
      return new Response(JSON.stringify({ error: { code: 'SYMBOL_NOT_FOUND', message: 'nope' } }), { status: 404 });
    });
    await expect(ok.rates('XAU USD', 'H1', 10)).rejects.toMatchObject({ code: 'SYMBOL_NOT_FOUND', status: 404 });
    expect(seen[0]).toEqual({ url: 'http://127.0.0.1:8765/v1/rates/XAU%20USD?timeframe=H1&count=10', auth: 'Bearer secret-token' });
    expect(seen[0]!.url).not.toContain('secret');
    await expect(ok.health()).rejects.toBeInstanceOf(BridgeResponseError);

    const down = new Mt5BridgeClient('http://127.0.0.1:8765', 't', 1000, () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(down.health()).rejects.toBeInstanceOf(BridgeOfflineError);
  });
});
