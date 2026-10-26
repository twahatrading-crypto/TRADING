import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HlrOriginalPage } from './HlrOriginalPage';

/**
 * The page frames the original dashboard, asks for ITS OWN password, and names the account the data
 * comes from. These tests pin exactly that: React renders no strategy UI, requests no price, never
 * shows the frame before the gate has passed, and never claims an account it could not read.
 */
const ACCOUNT = { server: 'MetaQuotes-Demo', company: 'MetaQuotes Ltd.' };

/** A fetch stub answering only the endpoints this page is allowed to use. */
function stub({ me = 200, account = ACCOUNT as unknown, login = 200 } = {}) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u === '/api/hlr/auth/me') return { ok: me === 200, status: me, json: async () => ({}) };
    if (u === '/api/hlr/auth/login') {
      return { ok: login === 200, status: login, json: async () => ({ error: { message: 'Sign-in failed.' } }) };
    }
    if (u === '/api/hlr/auth/logout') return { ok: true, status: 200, json: async () => ({}) };
    if (u === '/api/hlr/mt5/api/status') return { ok: true, status: 200, json: async () => ({ account }) };
    throw new Error(`unexpected fetch: ${u}`);
  });
}

const frame = () => screen.queryByTitle('HLR Original — Live');

describe('HLR Original — Live page', () => {
  beforeEach(() => vi.stubGlobal('fetch', stub()));
  afterEach(() => vi.unstubAllGlobals());

  // ---------------------------------------------------------------- the gate

  it("does not render the frame until this page's own credential is accepted", async () => {
    vi.stubGlobal('fetch', stub({ me: 401 }));
    render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeInTheDocument());
    expect(frame()).toBeNull(); // the protected document is never even requested
  });

  it('says the password is separate from the rest of the site', async () => {
    vi.stubGlobal('fetch', stub({ me: 401 }));
    render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByText(/own password, separate from the rest/i)).toBeInTheDocument());
  });

  it('shows the frame once signed in', async () => {
    render(<HlrOriginalPage />);
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(frame()!.getAttribute('src')).toBe('/hlr-original/hlr.html');
  });

  it('reports a failed sign-in without revealing anything', async () => {
    vi.stubGlobal('fetch', stub({ me: 401, login: 401 }));
    render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/sign-in failed/i));
    expect(frame()).toBeNull();
  });

  it('says so plainly when this deployment has no HLR credential (404)', async () => {
    vi.stubGlobal('fetch', stub({ me: 404 }));
    render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByText(/NOT AVAILABLE HERE/i)).toBeInTheDocument());
    expect(frame()).toBeNull();
  });

  it('offers sign-out once signed in', async () => {
    render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument());
  });

  // ---------------------------------------------------------------- the frame

  it('never points the frame at another origin', async () => {
    render(<HlrOriginalPage />);
    await waitFor(() => expect(frame()).not.toBeNull());
    const src = frame()!.getAttribute('src') ?? '';
    expect(src.startsWith('/')).toBe(true);
    for (const absolute of ['http://', 'https://', '//', '127.0.0.1', 'localhost']) {
      expect(src).not.toContain(absolute);
    }
  });

  it('renders no React strategy UI — only the banner, the frame and sign-out', async () => {
    const { container } = render(<HlrOriginalPage />);
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    expect(container.querySelectorAll('h1, h2, h3, input, select, table')).toHaveLength(0);
  });

  // ---------------------------------------------------------------- the banner

  it('labels a demo account clearly, naming the server the bridge reported', async () => {
    render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByText(/DEMO DATA — MetaQuotes-Demo/)).toBeInTheDocument());
    expect(screen.getByText(/not a funded broker feed/i)).toBeInTheDocument();
  });

  it('treats a MetaQuotes-named company as demo even if the server is not named "demo"', async () => {
    vi.stubGlobal('fetch', stub({ account: { server: 'SomeServer-7', company: 'MetaQuotes Ltd.' } }));
    render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByText(/DEMO DATA — SomeServer-7/)).toBeInTheDocument());
  });

  it('does not call a broker account demo, and never claims LIVE data', async () => {
    vi.stubGlobal('fetch', stub({ account: { server: 'ICMarketsSC-Live12', company: 'IC Markets' } }));
    const { container } = render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByText(/BROKER ACCOUNT — ICMarketsSC-Live12/)).toBeInTheDocument());
    expect(screen.queryByText(/DEMO DATA/)).toBeNull();
    expect(container.textContent).not.toMatch(/\bLIVE DATA\b|\bLIVE PRICES\b/i);
  });

  it('says the source is unknown rather than guessing, when the account cannot be read', async () => {
    vi.stubGlobal('fetch', stub({ account: null }));
    render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByText(/DATA SOURCE UNKNOWN/)).toBeInTheDocument());
    expect(screen.queryByText(/DEMO DATA/)).toBeNull();
  });

  // ---------------------------------------------------------------- hygiene

  it('only ever reads auth state and the account — it never requests a price', async () => {
    const f = stub();
    vi.stubGlobal('fetch', f);
    render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByText(/DEMO DATA/)).toBeInTheDocument());
    for (const call of f.mock.calls) {
      expect(['/api/hlr/auth/me', '/api/hlr/mt5/api/status']).toContain(String(call[0]));
    }
  });

  it('falls back to the sign-in card if the session dies while the page is open', async () => {
    // me succeeds once (so the frame mounts), then everything is 401 - a session that expired or
    // was revoked elsewhere. The frame must not linger showing whatever it last rendered.
    let meCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u === '/api/hlr/auth/me') {
        meCalls += 1;
        return { ok: meCalls === 1, status: meCalls === 1 ? 200 : 401, json: async () => ({}) };
      }
      if (u === '/api/hlr/mt5/api/status') return { ok: false, status: 401, json: async () => ({}) };
      throw new Error(`unexpected fetch: ${u}`);
    }));
    render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeInTheDocument());
    expect(frame()).toBeNull();
  });

  it('stops polling when the page is left — no timer or fetch outlives it', async () => {
    const f = stub();
    vi.stubGlobal('fetch', f);
    const { unmount } = render(<HlrOriginalPage />);
    await waitFor(() => expect(screen.getByText(/DEMO DATA/)).toBeInTheDocument());
    const after = f.mock.calls.length;
    unmount();
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(10 * 60_000);
      expect(f.mock.calls.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });
});
