import { CheckCircle2, ChevronLeft, ChevronRight, Pause, Play, RotateCcw, ShieldCheck, X, XCircle } from 'lucide-react';
import { useState } from 'react';
import { HLR_REPLAY_SPEEDS, type HLRReplaySession } from '../../services/hlReversal/HLRReplay';
import { runHLRAudit, type HLRAuditReport } from '../../services/hlReversal/replayAudit';
import { useStore } from '../../store/createStore';
import { fmtUtc } from './format';

/** High / Low Reversal replay transport (separate from every other replay). */
export function HLRReplayBar({ session, onExit }: { session: HLRReplaySession; onExit: () => void }) {
  const s = useStore(session.store, (x) => x);
  const [audit, setAudit] = useState<{ running: boolean; progress: string; report: HLRAuditReport | null }>({ running: false, progress: '', report: null });
  const atStart = s.cursor <= 0;
  const atEnd = s.cursor >= s.total - 1;
  const verify = async () => {
    session.pause();
    setAudit({ running: true, progress: '…', report: null });
    const report = await runHLRAudit(session.dataset, s.timeframe, (label) => setAudit((a) => ({ ...a, progress: label })));
    setAudit({ running: false, progress: '', report });
  };
  const r = audit.report;
  return (
    <div className="replay hlrreplay" role="region" aria-label="High / Low Reversal replay controls" data-testid="hlr-replay-bar">
      <div className="replay__row">
        <span className="replay__badge">REPLAY</span>
        <div className="replay__transport" role="group" aria-label="Replay transport">
          <button type="button" className="rbtn" onClick={() => session.reset()} disabled={atStart} aria-label="Reset to first candle" title="Reset">
            <RotateCcw size={15} />
          </button>
          <button type="button" className="rbtn" onClick={() => session.step(-1)} disabled={atStart} aria-label="Step back one candle" title="Step back 1 candle">
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="rbtn rbtn--play" onClick={() => session.toggle()} disabled={!s.playing && atEnd} aria-label={s.playing ? 'Pause' : 'Play'}>
            {s.playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button type="button" className="rbtn" onClick={() => session.step(1)} disabled={atEnd} aria-label="Step forward one candle" title="Step forward 1 candle">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="seg replay__speed" role="group" aria-label="Replay speed">
          {HLR_REPLAY_SPEEDS.map((v) => (
            <button key={v} type="button" className="seg__btn" aria-selected={s.speed === v} onClick={() => session.setSpeed(v)}>
              {v}x
            </button>
          ))}
        </div>
        <dl className="replay__read">
          <div><dt>Replay time</dt><dd data-testid="hlr-replay-time">{fmtUtc(s.knowledgeTime)}</dd></div>
          <div><dt>Visible</dt><dd className="num" data-testid="hlr-replay-count">{(s.cursor + 1).toLocaleString('en-US')} / {s.total.toLocaleString('en-US')}</dd></div>
          <div>
            <dt>Parity</dt>
            <dd className={s.parity ? (s.parity.ok ? 'ok' : 'bad') : ''} data-testid="hlr-replay-parity" title="Incremental replay state vs a clean recomputation from the candles known at this time">
              {s.parity ? (s.parity.ok ? 'MATCH' : 'MISMATCH') : '—'}
            </dd>
          </div>
        </dl>
        <div className="replay__actions">
          <button type="button" className="rbtn rbtn--text" onClick={() => void verify()} disabled={audit.running} title="Step every closed bar of H4 / H1 / M15 / M5 / M1 and check that nothing recorded ever changes later">
            <ShieldCheck size={15} /> {audit.running ? `Verifying ${audit.progress}` : 'Verify no-repaint'}
          </button>
          <button type="button" className="rbtn rbtn--text rbtn--exit" onClick={onExit}>
            <X size={15} /> Exit Replay
          </button>
        </div>
      </div>
      <div className="replay__row replay__row--seek">
        <input type="range" className="replay__scrub" min={0} max={Math.max(0, s.total - 1)} value={Math.max(0, s.cursor)} onChange={(e) => session.seek(Number(e.target.value))} aria-label="Replay position (candle)" />
        <span className="replay__hint">Click a candle to jump there. Every stage appears only once the candle that proves it has closed.</span>
      </div>
      {r && (
        <div className={`raudit ${r.passed ? 'is-pass' : 'is-fail'}`} data-testid="hlr-audit">
          <div className="raudit__head">
            {r.passed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            <strong>{r.passed ? 'PASS — NO REPAINT DETECTED' : 'FAIL — REPAINT / LOOKAHEAD DETECTED'}</strong>
            <span className="srmuted">
              {r.instrumentId} · {Object.entries(r.bars).map(([tf, n]) => `${tf} ${n}`).join(' · ')} · {r.ms} ms
            </span>
            <button type="button" className="rbtn rbtn--icon" onClick={() => setAudit({ running: false, progress: '', report: null })} aria-label="Close audit result">
              <X size={14} />
            </button>
          </div>
          <table className="raudit__table">
            <thead>
              <tr><th>Steps</th><th>Levels</th><th>Setups</th><th>Sweeps</th><th>Reclaims</th><th>M5</th><th>Entry ready</th><th>Result</th></tr>
            </thead>
            <tbody>
              <tr>
                <td className="num">{r.audit.steps}</td>
                <td className="num">{r.audit.levels}</td>
                <td className="num">{r.audit.setups}</td>
                <td className="num">{r.audit.sweeps}</td>
                <td className="num">{r.audit.reclaims}</td>
                <td className="num">{r.audit.confirmations}</td>
                <td className="num">{r.audit.entryReady}</td>
                <td className={r.audit.violations.length ? 'bad' : 'ok'}>{r.audit.violations.length ? `${r.audit.violations.length} issue(s)` : 'PASS'}</td>
              </tr>
              <tr>
                <td colSpan={7} className="srmuted">replay parity · {r.replay.timeframe} · {r.replay.steps} positions vs clean recomputation</td>
                <td className={r.replay.mismatches.length ? 'bad' : 'ok'}>{r.replay.mismatches.length ? `${r.replay.mismatches.length} issue(s)` : 'PASS'}</td>
              </tr>
            </tbody>
          </table>
          {!r.passed && (
            <ol className="raudit__list">
              {[...r.audit.violations, ...r.replay.mismatches].slice(0, 20).map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
