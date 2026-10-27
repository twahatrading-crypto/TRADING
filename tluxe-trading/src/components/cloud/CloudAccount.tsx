import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { changePassword, fetchAccount, type FetchLike, type OwnerAccount } from '../../services/cloud/cloudApi';
import './cloud.css';

const MIN = 12;

/** Owner account: who is signed in, session limits, and the password change (current + new; stored only as a hash). */
export function CloudAccount({ fetchImpl }: { fetchImpl?: FetchLike }) {
  const [acct, setAcct] = useState<OwnerAccount | null>(null);
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    void fetchAccount(fetchImpl).then((a) => live && setAcct(a));
    return () => {
      live = false;
    };
  }, [fetchImpl]);
  const problem = !next ? null : next.length < MIN ? `At least ${MIN} characters.` : next === cur ? 'Must differ from the current password.' : confirm && confirm !== next ? 'The two new passwords do not match.' : null;
  const canSubmit = !!cur && next.length >= MIN && next === confirm && next !== cur && !busy;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setMsg(null);
    try {
      await changePassword(cur, next, fetchImpl);
      setMsg({ ok: true, text: 'Password changed. Every other session has been signed out.' });
      setCur('');
      setNext('');
      setConfirm('');
      setOpen(false);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Password change failed.' });
    } finally {
      setBusy(false);
    }
  };
  const type = show ? 'text' : 'password';
  return (
    <div className="cloud-account" data-testid="cloud-account">
      <p className="cloud-account__who">
        Signed in as <strong>{acct?.email ?? 'owner'}</strong>
        {acct?.maxAgeS && acct.idleTimeoutS ? (
          <small>
            {' '}
            · session ends after {Math.round(acct.maxAgeS / 3600)} h, or {Math.round(acct.idleTimeoutS / 60)} min without activity
          </small>
        ) : null}
      </p>
      {msg && (
        <p className={msg.ok ? 'cloud-account__ok' : 'cloud-signin__error'} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
      {!open ? (
        <button type="button" className="sbtn cloud-account__toggle" onClick={() => setOpen(true)}>
          <KeyRound size={13} /> Change password
        </button>
      ) : (
        <form className="cloud-account__form" onSubmit={submit} aria-label="Change password">
          <label>
            <span>Current password</span>
            <input type={type} autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} maxLength={256} required />
          </label>
          <label>
            <span>New password</span>
            <input type={type} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} maxLength={256} required minLength={MIN} />
          </label>
          <label>
            <span>Confirm new password</span>
            <input type={type} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={256} required />
          </label>
          {problem && <small className="cloud-account__hint">{problem}</small>}
          <div className="cloud-account__actions">
            <button type="button" className="sbtn" onClick={() => setShow((v) => !v)} aria-pressed={show} aria-label={show ? 'Hide passwords' : 'Show passwords'}>
              {show ? <EyeOff size={13} /> : <Eye size={13} />} {show ? 'Hide' : 'Show'}
            </button>
            <button type="button" className="sbtn" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="sbtn" disabled={!canSubmit} aria-busy={busy}>
              {busy ? 'Saving…' : 'Save new password'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
