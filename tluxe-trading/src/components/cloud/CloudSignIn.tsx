import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { login, type FetchLike } from '../../services/cloud/cloudApi';
import './cloud.css';

/**
 * Private owner sign-in for the cloud deployment (single owner - no registration, no recovery e-mail, no social login).
 * The password goes once to the gateway over HTTPS; the gateway answers with an HttpOnly session cookie. Nothing is
 * stored in the browser by this form.
 */
export function CloudSignIn({ onSignedIn, gatewayDown = false, fetchImpl }: { onSignedIn: () => void; gatewayDown?: boolean; fetchImpl?: FetchLike }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(gatewayDown ? 'The TLUXE gateway is not reachable right now.' : null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(password, fetchImpl);
      setPassword('');
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="cloud-signin">
      <form className="cloud-signin__card" onSubmit={submit} aria-label="Sign in to TLUXE Trading">
        <div className="cloud-signin__brand" aria-label="TLUXE | TRADING">
          <span className="cloud-signin__mark">TLUXE</span>
          <span className="cloud-signin__sep" aria-hidden="true">|</span>
          <span className="cloud-signin__app">TRADING</span>
        </div>
        <p className="cloud-signin__note">
          <LockKeyhole size={13} aria-hidden="true" /> Private owner access
        </p>
        <label className="cloud-signin__field" htmlFor="tluxe-owner-password">
          <span>Password</span>
        </label>
        <div className="cloud-signin__pw">
          <input
            id="tluxe-owner-password"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
            maxLength={256}
            spellCheck={false}
            autoCapitalize="off"
          />
          <button type="button" className="cloud-signin__eye" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {error && (
          <p className="cloud-signin__error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="cloud-signin__btn" disabled={busy || !password}>
          {busy ? 'SIGNING IN…' : 'SIGN IN'}
        </button>
        <p className="cloud-signin__foot">Read-only market analysis · no trading, no orders</p>
      </form>
    </main>
  );
}
