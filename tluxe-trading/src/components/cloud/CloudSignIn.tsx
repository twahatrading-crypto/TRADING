import { LockKeyhole } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { login, type FetchLike } from '../../services/cloud/cloudApi';
import './cloud.css';

/**
 * Owner sign-in for the cloud deployment. The password goes once to the gateway over HTTPS; the gateway answers with
 * an HttpOnly session cookie. Nothing is stored in the browser by this form.
 */
export function CloudSignIn({ onSignedIn, gatewayDown = false, fetchImpl }: { onSignedIn: () => void; gatewayDown?: boolean; fetchImpl?: FetchLike }) {
  const [password, setPassword] = useState('');
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
      <form className="cloud-signin__card" onSubmit={submit} aria-label="Sign in to Trading by TLUXE">
        <div className="cloud-signin__brand">
          <LockKeyhole size={18} />
          <span>Trading by TLUXE</span>
        </div>
        <p className="cloud-signin__note">Owner access. Read-only market analysis — no trading, no orders.</p>
        <label className="cloud-signin__field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required maxLength={256} />
        </label>
        {error && (
          <p className="cloud-signin__error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="cloud-signin__btn" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
