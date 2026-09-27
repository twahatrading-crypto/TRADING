import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Deployment from '../../config/deployment';

/**
 * The cloud build wiring (VITE_TLUXE_DEPLOYMENT=cloud is a BUILD-time constant, so the module is re-imported with the
 * cloud flag). Every provider goes through the gateway on the page origin, nothing from an old local setup is used,
 * and with the upstream services down everything stays unavailable - nothing is generated to fill the gap.
 */
vi.mock('../../config/deployment', async (importOriginal) => {
  const real = await importOriginal<typeof Deployment>();
  return {
    ...real,
    IS_CLOUD: true,
    DEPLOYMENT: 'cloud',
    backendCredentials: () => 'same-origin',
    resolveBackendConfig: <T extends { enabled: boolean; token: string }>(cfg: T, key: Parameters<typeof real.resolveBackendConfig>[1], field: keyof T) =>
      real.resolveBackendConfig(cfg, key, field, true, 'https://tluxe.example.app'),
  };
});

const { createServices, defaultProviders } = await import('../registry');

const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

afterEach(() => vi.unstubAllGlobals());

describe('cloud registry', () => {
  it('routes MT5, Databento, news and AI through the gateway, ignoring locally stored URLs / tokens', async () => {
    const LOCAL = 'local-token-' + 'z'.repeat(40);
    const storage = memory({
      'tluxe.mt5.config.v1': JSON.stringify({ enabled: false, bridgeUrl: 'http://127.0.0.1:8765', token: LOCAL }),
      'tluxe.databento.config.v1': JSON.stringify({ enabled: false, bridgeUrl: 'http://127.0.0.1:8766', token: LOCAL }),
    });
    const urls: string[] = [];
    const inits: RequestInit[] = [];
    // TEST gateway with every upstream down (what a fresh Railway deploy without credentials answers).
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init: RequestInit) => {
        urls.push(u);
        inits.push(init);
        return new Response(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'not configured' } }), { status: 503 });
      }),
    );
    const p = defaultProviders(storage);
    expect(p.databento).not.toBeNull();
    expect(p.newsBridge).not.toBeNull();
    expect(p.price.length).toBe(2); // MT5 relay + Databento market adapter
    const s = createServices(p);
    s.market.connect();
    s.market.activate('XAUUSD');
    await p.databento!.pollOnce?.();
    await p.newsBridge!.pollOnce();
    await vi.waitFor(() => expect(urls.some((u) => u.startsWith('https://tluxe.example.app/api/mt5/v1/'))).toBe(true));
    s.market.disconnect();
    expect(urls.some((u) => u.startsWith('https://tluxe.example.app/api/news/v1/health'))).toBe(true);
    // Only the gateway origin - never a local bridge - and never the stored local token.
    expect(urls.every((u) => u.startsWith('https://tluxe.example.app/api/'))).toBe(true);
    expect(JSON.stringify(inits)).not.toContain(LOCAL);
    // Upstreams down -> unavailable; no price is invented.
    expect(p.newsBridge!.state.getState().bridge).toBe('OFFLINE');
    const m = s.market.store('XAUUSD').getState();
    expect(m.quote.last).toBeNull();
    expect(m.quote.bid).toBeNull();
  });
});
