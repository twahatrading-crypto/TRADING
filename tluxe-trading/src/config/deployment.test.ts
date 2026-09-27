import { describe, expect, it } from 'vitest';
import { DEFAULT_TLUXE_AI_CONFIG, sanitizeTluxeAiConfig } from '../providers/ai/config';
import { DEFAULT_DATABENTO_CONFIG, sanitizeDatabentoConfig } from '../providers/databento/config';
import { DEFAULT_NEWS_BRIDGE_CONFIG } from '../providers/newsBridge/config';
import { DEFAULT_MT5_CONFIG, sanitizeMt5Config } from '../services/mt5/config';
import { backendCredentials, CLOUD_PATHS, CLOUD_SESSION_TOKEN, cloudBackendUrl, defaultBackendUrl, DEPLOYMENT, IS_CLOUD, LOCAL_BACKEND_URLS, resolveBackendConfig } from './deployment';

const ORIGIN = 'https://tluxe.example.app';

describe('deployment mode - local development is unchanged', () => {
  it('tests and `npm run dev` build the LOCAL mode with the private 127.0.0.1 bridges', () => {
    expect(IS_CLOUD).toBe(false);
    expect(DEPLOYMENT).toBe('local');
    expect(DEFAULT_MT5_CONFIG.bridgeUrl).toBe('http://127.0.0.1:8765');
    expect(DEFAULT_DATABENTO_CONFIG.bridgeUrl).toBe('http://127.0.0.1:8766');
    expect(DEFAULT_TLUXE_AI_CONFIG.url).toBe('http://127.0.0.1:8767');
    expect(DEFAULT_NEWS_BRIDGE_CONFIG.url).toBe('http://127.0.0.1:8768');
    expect(LOCAL_BACKEND_URLS).toEqual({ mt5: 'http://127.0.0.1:8765', databento: 'http://127.0.0.1:8766', ai: 'http://127.0.0.1:8767', news: 'http://127.0.0.1:8768' });
    // Local bridges never receive browser cookies.
    expect(backendCredentials()).toBe('omit');
  });

  it('local: stored configuration (URL, token, enabled) is used exactly as before', () => {
    const cfg = sanitizeMt5Config({ enabled: true, bridgeUrl: 'http://127.0.0.1:9999', token: 't'.repeat(40) });
    expect(resolveBackendConfig(cfg, 'mt5', 'bridgeUrl')).toBe(cfg);
    const off = sanitizeDatabentoConfig(null);
    expect(resolveBackendConfig(off, 'databento', 'bridgeUrl').enabled).toBe(false);
  });
});

describe('deployment mode - cloud never depends on localhost or browser-held credentials', () => {
  it('cloud: every backend is the gateway on the page origin', () => {
    expect(cloudBackendUrl('mt5', ORIGIN)).toBe(`${ORIGIN}/api/mt5`);
    expect(cloudBackendUrl('databento', ORIGIN)).toBe(`${ORIGIN}/api/databento`);
    expect(cloudBackendUrl('news', ORIGIN)).toBe(`${ORIGIN}/api/news`);
    expect(cloudBackendUrl('ai', ORIGIN)).toBe(ORIGIN); // the AI client already calls /api/ai/...
    for (const p of Object.values(CLOUD_PATHS)) expect(p === '' || p.startsWith('/api/')).toBe(true);
    expect(backendCredentials(true)).toBe('same-origin');
    // Always the page's own origin (whatever domain serves the app) - never a hard-coded bridge address.
    expect(defaultBackendUrl('mt5', true)).toBe(`${window.location.origin}/api/mt5`);
    expect(defaultBackendUrl('mt5', true)).not.toContain(':8765');
  });

  it('cloud: stored local URLs and tokens are IGNORED; the placeholder is not a credential', () => {
    const stored = sanitizeTluxeAiConfig({ enabled: false, url: 'http://127.0.0.1:8767', token: 'local-ai-token-' + 'x'.repeat(30) });
    const c = resolveBackendConfig(stored, 'ai', 'url', true, ORIGIN);
    expect(c.url).toBe(ORIGIN);
    expect(c.token).toBe(CLOUD_SESSION_TOKEN);
    expect(JSON.stringify(c)).not.toContain('local-ai-token');
    expect(c.enabled).toBe(true); // the gateway reports what is really connected; nothing is simulated
    const m = resolveBackendConfig(sanitizeMt5Config({ enabled: true, bridgeUrl: 'http://127.0.0.1:8765', token: 'm'.repeat(40) }), 'mt5', 'bridgeUrl', true, ORIGIN);
    expect(m.bridgeUrl).toBe(`${ORIGIN}/api/mt5`);
    expect(m.token).toBe(CLOUD_SESSION_TOKEN);
  });
});
