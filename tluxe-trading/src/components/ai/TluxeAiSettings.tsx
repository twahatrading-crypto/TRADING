import { BrainCircuit, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useServices } from '../../app/servicesContext';
import { loadTluxeAiConfig, looksLikeOpenAiKey, saveTluxeAiConfig, TLUXE_AI_DEFAULT_URL, type TluxeAiConfig } from '../../providers/ai/config';
import { useStore } from '../../store/createStore';
import { Panel } from '../ui/Panel';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Settings → TLUXE AI. Only the LOCAL backend URL and the backend token are configured in the browser.
 * The OpenAI API key is never entered here: it is OPENAI_API_KEY in bridge/ai/.env (server-side only).
 */
export function TluxeAiSettingsPanel() {
  const [cfg, setCfg] = useState<TluxeAiConfig>(() => loadTluxeAiConfig(storage()));
  const { ai } = useServices();
  const st = useStore(ai.store, (s) => s);
  const set = <K extends keyof TluxeAiConfig>(k: K, v: TluxeAiConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const looksLikeKey = looksLikeOpenAiKey(cfg.token);
  const tokenOk = cfg.token.length >= 32 && !looksLikeKey;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveTluxeAiConfig(storage(), cfg);
    window.location.reload();
  };
  return (
    <Panel id="tluxe-ai-config" title="TLUXE AI" icon={<BrainCircuit size={15} />} subtitle="Local TLUXE AI backend → OpenAI Responses API · read-only">
      <form className="sform" onSubmit={submit} data-testid="tluxe-ai-settings">
        <label className="sform__check">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Enable TLUXE AI (local backend bridge\ai, default {TLUXE_AI_DEFAULT_URL})
        </label>
        <label className="sform__field">
          <span>Backend URL</span>
          <input type="url" value={cfg.url} onChange={(e) => set('url', e.target.value)} spellCheck={false} />
        </label>
        <label className="sform__field">
          <span>Backend token</span>
          <input type="password" autoComplete="off" value={cfg.token} onChange={(e) => set('token', e.target.value)} placeholder="TLUXE_AI_TOKEN from bridge/ai/.env" spellCheck={false} />
        </label>
        {looksLikeKey && <p className="sform__warn">That looks like an OpenAI API key. Never enter it in the browser — it belongs only in bridge/ai/.env as OPENAI_API_KEY.</p>}
        {cfg.token && !looksLikeKey && !tokenOk && <p className="sform__warn">The backend token is at least 32 characters.</p>}
        <p className="sform__note" data-testid="tluxe-ai-settings-status">
          AI provider: <strong>{st.status === 'CONNECTED' ? `Connected · ${st.providerName}` : 'Not Connected'}</strong>
          {st.status !== 'CONNECTED' && st.statusReason ? ` — ${st.statusReason}` : ''}
        </p>
        <p className="sform__note">
          <ShieldCheck size={13} /> Your OpenAI API key stays on the TLUXE AI backend (server-side environment only). This browser stores only the backend URL and backend token.
        </p>
        <div className="sform__actions">
          <button type="submit" className="sbtn" disabled={cfg.enabled && !tokenOk}>
            Save &amp; reconnect
          </button>
        </div>
      </form>
    </Panel>
  );
}
