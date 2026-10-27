import { useCallback, useEffect, useState } from 'react';
import './hlrOriginal.css';

/** Whether this page's own credential has been accepted. Nothing here touches the site's own auth. */
type Auth = 'checking' | 'required' | 'ok' | 'unavailable';

/** Whether the dashboard files are actually present on the private volume. */
type Files = 'checking' | 'present' | 'missing';

/** What the MT5 bridge on the trading PC reports about the account behind the data. */
type Source =
  | { state: 'loading' }
  | { state: 'unavailable'; detail: string }
  | { state: 'known'; server: string; company: string | null; demo: boolean };

const SOURCE_POLL_MS = 60_000;

/** A demo server is named as one, or carries MetaQuotes' own name - MetaQuotes is the vendor, not a broker. */
function isDemo(server: string, company: string | null): boolean {
  return /demo/i.test(server) || /metaquotes/i.test(company ?? '');
}

function useAuth(): [Auth, () => void, boolean] {
  const [auth, setAuth] = useState<Auth>('checking');
  // True only when a real session exists - i.e. a password is configured and we signed in.
  const [hasSession, setHasSession] = useState(false);
  const check = useCallback(() => {
    void (async () => {
      try {
        const r = await fetch('/api/hlr/auth/me', { cache: 'no-store' });
        if (r.ok) { setHasSession(true); return setAuth('ok'); }
        if (r.status !== 404) return setAuth('required');
        // 404: no sign-in exists here. Either the page is PUBLIC (no password configured, open to
        // everyone) or the feature is absent. /api/hlr/files tells the two apart - it is registered
        // whenever the page is, and in public mode it answers without a session.
        const probe = await fetch('/api/hlr/files', { cache: 'no-store' });
        setAuth(probe.ok ? 'ok' : 'unavailable');
      } catch {
        setAuth('unavailable');
      }
    })();
  }, []);
  useEffect(check, [check]);
  return [auth, check, hasSession];
}

/**
 * Reads the account the dashboard's data comes from, through the same relay the dashboard uses.
 * It never reads a price and never affects the engine - only which account is connected.
 */
function useSource(enabled: boolean, onUnauthorized: () => void): Source {
  const [source, setSource] = useState<Source>({ state: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const read = async () => {
      try {
        const r = await fetch('/api/hlr/mt5/api/status', { cache: 'no-store' });
        if (cancelled) return;
        if (!r.ok) {
          setSource({ state: 'unavailable', detail: r.status === 401 ? 'Sign in required.' : 'The MT5 bridge is not reachable.' });
          // The session died while the page was open. Re-check auth so the frame is replaced by the
          // sign-in card instead of lingering with the last values it happened to have rendered.
          if (r.status === 401) onUnauthorized();
          return;
        }
        const body = (await r.json()) as { account?: { server?: string; company?: string } };
        if (cancelled) return;
        const server = body.account?.server;
        if (!server) {
          setSource({ state: 'unavailable', detail: 'The bridge did not report an account.' });
          return;
        }
        const company = body.account?.company ?? null;
        setSource({ state: 'known', server, company, demo: isDemo(server, company) });
      } catch {
        if (!cancelled) setSource({ state: 'unavailable', detail: 'The MT5 bridge is not reachable.' });
      }
    };
    void read();
    const timer = window.setInterval(read, SOURCE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, onUnauthorized]);
  return source;
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/hlr/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        setPassword('');
        onSignedIn();
        return;
      }
      const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? 'Sign-in failed.');
    } catch {
      setError('The gateway is not reachable.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hlrorig__gate">
      <form className="hlrorig__card" onSubmit={submit}>
        <h1>HLR Original — Live</h1>
        <p className="hlrorig__card-sub">
          This page has its own password, separate from the rest of Trading by TLUXE.
        </p>
        <label htmlFor="hlr-pw">Password</label>
        <input
          id="hlr-pw"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        {error && <p className="hlrorig__card-err" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="hlrorig__card-foot">Read-only market analysis · no trading, no orders</p>
      </form>
    </div>
  );
}

function SourceBanner({ source, onSignOut }: { source: Source; onSignOut: (() => void) | null }) {
  // No sign-out when the page is public: there is no session to end.
  const out = onSignOut
    ? <button type="button" className="hlrorig__signout" onClick={onSignOut}>Sign out</button>
    : null;
  if (source.state === 'loading') return null;
  if (source.state === 'unavailable') {
    return (
      <div className="hlrorig__banner hlrorig__banner--unknown" role="status">
        <b>DATA SOURCE UNKNOWN</b>
        <span>{source.detail} The dashboard below reports its own connection state.</span>
        {out}
      </div>
    );
  }
  if (source.demo) {
    return (
      <div className="hlrorig__banner hlrorig__banner--demo" role="status">
        <b>DEMO DATA — {source.server}</b>
        <span>
          Prices come from a demo account, not a funded broker feed. They can quote outside real market
          hours, and levels, sweeps and wicks will not match a live broker — so signals may differ from
          what you would actually trade.
        </span>
        {out}
      </div>
    );
  }
  return (
    <div className="hlrorig__banner hlrorig__banner--broker" role="status">
      <b>BROKER ACCOUNT — {source.server}</b>
      <span>
        Prices come from this broker account. Whether they are current is shown by the dashboard's own
        LIVE / STALE / MARKET CLOSED state below.
      </span>
      {out}
    </div>
  );
}

/**
 * HLR ORIGINAL — LIVE
 *
 * The owner's original High / Low Reversal dashboard, shown exactly as it runs on the trading PC.
 * Its HTML, CSS and JavaScript are served byte-for-byte from `/hlr-original/` and rendered in a
 * SAME-ORIGIN iframe, so the dashboard keeps its own document: its stylesheet cannot leak into
 * TLUXE and TLUXE's cannot leak into it.
 *
 * This page - and only this page - asks for a password. It is a separate credential from the rest of
 * Trading by TLUXE, which stays publicly accessible exactly as it is. The gate that matters is on
 * the server: the frame is not even requested until `/api/hlr/auth/me` succeeds, and every file
 * behind it is refused without the HLR session however the URL is spelled.
 *
 * React does nothing else here but size the frame and name the account the data comes from. It never
 * reads the dashboard's DOM, never fetches a price, and never takes part in its analysis.
 */
export function HlrOriginalPage() {
  const [auth, recheck, hasSession] = useAuth();
  const source = useSource(auth === 'ok', recheck);
  const [files, setFiles] = useState<Files>('checking');

  useEffect(() => {
    if (auth !== 'ok') return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/hlr/files', { cache: 'no-store' });
        if (cancelled) return;
        const b = r.ok ? ((await r.json()) as { entry?: boolean }) : null;
        setFiles(b?.entry === true ? 'present' : 'missing');
      } catch {
        if (!cancelled) setFiles('missing');
      }
    })();
    return () => { cancelled = true; };
  }, [auth]);

  const signOut = useCallback(() => {
    void (async () => {
      try {
        await fetch('/api/hlr/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      } finally {
        recheck();
      }
    })();
  }, [recheck]);

  if (auth === 'checking' || (auth === 'ok' && files === 'checking')) return <div className="hlrorig" />;
  if (auth === 'unavailable') {
    return (
      <div className="hlrorig">
        <div className="hlrorig__banner hlrorig__banner--unknown" role="status">
          <b>HLR ORIGINAL IS NOT AVAILABLE HERE</b>
          <span>This deployment has no HLR credential configured, so the dashboard is not served.</span>
        </div>
      </div>
    );
  }
  if (auth === 'required') return <div className="hlrorig"><SignIn onSignedIn={recheck} /></div>;
  if (files === 'missing') {
    // Nothing has been uploaded to the private volume. Say so plainly rather than framing a 404
    // the browser would refuse to display anyway.
    return (
      <div className="hlrorig">
        <div className="hlrorig__banner hlrorig__banner--unknown" role="status">
          <b>DASHBOARD FILES NOT UPLOADED</b>
          <span>
            {/* Public mode has no sign-in at all, so this copy must not claim one. */}
            {hasSession
              ? 'You are signed in, but the private volume holds no dashboard yet, so there is nothing to show.'
              : 'The private volume holds no dashboard yet, so there is nothing to show.'}{' '}
            This is expected until the files are uploaded.
          </span>
          {hasSession && <button type="button" className="hlrorig__signout" onClick={signOut}>Sign out</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="hlrorig">
      <SourceBanner source={source} onSignOut={hasSession ? signOut : null} />
      <iframe
        className="hlrorig__frame"
        src="/hlr-original/hlr.html"
        title="HLR Original — Live"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
