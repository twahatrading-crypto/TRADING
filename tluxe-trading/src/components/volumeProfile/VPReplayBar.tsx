import { CheckCircle2, ChevronLeft, ChevronRight, Pause, Play, RotateCcw, ShieldCheck, X, XCircle } from 'lucide-react';
import { useState } from 'react';
import { auditVolumeProfile, type VPAuditResult } from '../../engines/volumeProfile/antiRepaint';
import { vpKnowledgeTimes } from '../../engines/volumeProfile/knowledge';
import { VP_REPLAY_SPEEDS, type VPReplaySession } from '../../services/volumeProfile/VPReplay';
import { useStore } from '../../store/createStore';
import { fmtUtc } from './vpView';

/** Volume Profile replay transport (separate from every other engine's replay). */
export function VPReplayBar({ session, onExit }: { session: VPReplaySession; onExit: () => void }) {
  const s = useStore(session.store, (x) => x);
  const [audit, setAudit] = useState<{ running: boolean; report: (VPAuditResult & { ms: number; closes: number }) | null }>({ running: false, report: null });
  const atStart = s.cursor <= 0;
  const atEnd = s.cursor >= s.total - 1;
  const verify = () => {
    session.pause();
    setAudit({ running: true, report: null });
    setTimeout(() => {
      const t0 = performance.now();
      const closes = vpKnowledgeTimes(session.dataset).length;
      const r = auditVolumeProfile(session.dataset, { stride: Math.max(1, Math.ceil(closes / 400)) });
      setAudit({ running: false, report: { ...r, ms: Math.round(performance.now() - t0), closes } });
    }, 0);
  };
  const r = audit.report;
  const passed = r ? !r.mismatches.length && !r.leaks.length && !r.mutations.length : false;
  return (
    <div className="replay smcreplay" role="region" aria-label="Volume Profile replay controls" data-testid="vp-replay-bar">
      <div className="replay__row">
        <span className="replay__badge">REPLAY</span>
        <div className="replay__transport" role="group" aria-label="Replay transport">
          <button type="button" className="rbtn" onClick={() => session.reset()} disabled={atStart} aria-label="Reset to first candle" title="Reset">
            <RotateCcw size={15} />
          </button>
          <button type="button" className="rbtn" onClick={() => session.step(-1)} disabled={atStart} aria-label="Step back one candle">
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="rbtn rbtn--play" onClick={() => session.toggle()} disabled={!s.playing && atEnd} aria-label={s.playing ? 'Pause' : 'Play'}>
            {s.playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button type="button" className="rbtn" onClick={() => session.step(1)} disabled={atEnd} aria-label="Step forward one candle">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="seg replay__speed" role="group" aria-label="Replay speed">
          {VP_REPLAY_SPEEDS.map((v) => (
            <button key={v} type="button" className="seg__btn" aria-selected={s.speed === v} onClick={() => session.setSpeed(v)}>
              {v}x
            </button>
          ))}
        </div>
        <dl className="replay__read">
          <div>
            <dt>Replay time</dt>
            <dd data-testid="vp-replay-time">{fmtUtc(s.knowledgeTime)}</dd>
          </div>
          <div>
            <dt>Visible</dt>
            <dd className="num" data-testid="vp-replay-count">
              {(s.cursor + 1).toLocaleString('en-US')} / {s.total.toLocaleString('en-US')}
            </dd>
          </div>
          <div>
            <dt>Parity</dt>
            <dd className={s.parity ? (s.parity.ok ? 'ok' : 'bad') : ''} data-testid="vp-replay-parity" title="Incremental replay vs a clean recomputation from the candles closed at this time">
              {s.parity ? (s.parity.ok ? 'MATCH' : 'MISMATCH') : '—'}
            </dd>
          </div>
        </dl>
        <div className="replay__actions">
          <button type="button" className="rbtn rbtn--text" onClick={verify} disabled={audit.running} title="Incremental vs clean recomputation, future leakage and frozen profiles / events across the loaded history">
            <ShieldCheck size={15} /> {audit.running ? 'Verifying…' : 'Verify No-Repaint'}
          </button>
          <button type="button" className="rbtn rbtn--text rbtn--exit" onClick={onExit}>
            <X size={15} /> Exit Replay
          </button>
        </div>
      </div>
      <div className="replay__row replay__row--seek">
        <input type="range" className="replay__scrub" min={0} max={Math.max(0, s.total - 1)} value={Math.max(0, s.cursor)} onChange={(e) => session.seek(Number(e.target.value))} aria-label="Replay position (candle)" />
        <span className="replay__hint">Click a candle to jump there. Profiles use only candles closed by the replay time.</span>
      </div>
      {r && (
        <div className={`raudit ${passed ? 'is-pass' : 'is-fail'}`} data-testid="vp-audit">
          <div className="raudit__head">
            {passed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            <strong>{passed ? 'VERIFY NO-REPAINT: PASS' : 'VERIFY NO-REPAINT: FAIL'}</strong>
            <span className="srmuted">
              {session.dataset.instrumentId} · {r.checks} checks of {r.closes} closes · {r.mismatches.length} mismatches · {r.leaks.length} leaks · {r.mutations.length} mutations · {r.ms} ms
            </span>
            <button type="button" className="rbtn rbtn--icon" onClick={() => setAudit({ running: false, report: null })} aria-label="Close audit result">
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
