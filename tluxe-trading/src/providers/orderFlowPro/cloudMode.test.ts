import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Deployment from '../../config/deployment';
import type { SourceStatus } from '../../engines/orderFlowPro/types';
import type { SourceSink } from './source';

/**
 * Website (cloud) build: VITE_TLUXE_DEPLOYMENT=cloud is a BUILD-time constant, so the modules are imported with the
 * cloud flag. There is no Order Flow Pro backend on the website: the page reports BACKEND OFFLINE, never polls, never
 * reads a stored local link and carries no loopback URL - nothing is simulated.
 */
vi.mock('../../config/deployment', async (importOriginal) => ({ ...(await importOriginal<typeof Deployment>()), IS_CLOUD: true, DEPLOYMENT: 'cloud' }));

const { DEFAULT_OFP_LINK, loadOfpLink, OFP_BACKEND_AVAILABLE, OFP_LINK_KEY } = await import('./config');
const { BackendSource } = await import('./BackendSource');

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Order Flow Pro in the website (cloud) build', () => {
  it('has no backend link and no loopback URL, even if an old local link is stored', () => {
    localStorage.setItem(OFP_LINK_KEY, JSON.stringify({ enabled: true, backendUrl: 'http://127.0.0.1:8770', token: 'x'.repeat(40) }));
    expect(OFP_BACKEND_AVAILABLE).toBe(false);
    expect(DEFAULT_OFP_LINK.backendUrl).toBe('');
    const link = loadOfpLink();
    expect(link.enabled).toBe(false);
    expect(link.token).toBe('');
    expect(link.backendUrl).toBe('');
  });

  it('reports BACKEND OFFLINE once and sends no request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const statuses: SourceStatus[] = [];
    const src = new BackendSource();
    const sink: SourceSink = { status: (s) => void statuses.push(s), frames: () => {}, time: () => {} };
    const stop = src.subscribe('GC', sink);
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.feed).toBe('BACKEND_OFFLINE');
    expect(statuses[0]!.diagnostics.join(' ')).toMatch(/No Order Flow Pro backend is deployed for this website/);
  });

  it('never sends the contract-selection request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(new BackendSource().selectContract('GC', 'GCZ6')).rejects.toThrow(/No Order Flow Pro backend/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
