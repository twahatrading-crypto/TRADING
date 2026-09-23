import { CheckCircle2, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Pause, Play, ShieldCheck, X, XCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { TIMEFRAME_SECONDS } from '../../engines/sr/settings';
import { REPLAY_SPEEDS, type SRReplaySession } from '../../services/sr/SRReplay';
import { runReplayAudit, type ReplayAuditReport } from '../../services/sr/replayAudit';
import { useStore } from '../../store/createStore';

const utc = (t: number | null) => (t === null ? '—' : `${new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
const toInput = (t: number | null) => (t === null ? '' : new Date(t * 1000).toISOString().slice(0, 16));

/** Replay transport + readouts. All state lives in the replay session (outside React). */
export function ReplayBar({ session, onExit }: { session: SRReplaySession; onExit: () => void }) {
  const s = useStore(session.store, (x) => x);
  const [jump, setJump] = useState('');
  const [audit, setAudit] = useState<{ running: boolean; progress: string; report: ReplayAuditReport | null }>({ running: false, progress: '', report: null });
  const atStart = s.cursor <= 0;
  const atEnd = s.cursor >= s.total - 1;

  const go = (e: FormEvent) => {
    e.preventDefault();
    const t = Date.parse(`${jump}:00Z`) / 1000;
    if (!Number.isFinite(t)) return;
    // Last bar that has CLOSED by the chosen time (never a bar that was still forming).
    const bars = session.dataset.candles[s.timeframe] ?? [];
    let idx = -1;
    const sec = TIMEFRAME_SECONDS[s.timeframe];
    for (let i = 0; i < bars.length; i++) if (bars[i]!.time + sec <= t) idx = i;
    if (idx >= 0) session.seek(idx);
  };

  const verify = async () => {
    session.pause();
    setAudit({ running: true, progress: 'starting…', report: null });
    const report = await runReplayAudit(session.dataset, s.timeframe, (done, total, label) =>
      setAudit((a) => ({ ...a, progress: `${label} (${done}/${total})` })),
    );
    setAudit({ running: false, progress: '', report });
  };

  return (
    <div className="replay" role="region" aria-label="Replay controls" data-testid="replay-bar">
      <div className="replay__row">
        <span className="replay__badge">REPLAY</span>
        <div className="replay__transport" role="group" aria-label="Replay transport">
          <button type="button" className="rbtn" onClick={() => session.toStart()} disabled={atStart} aria-label="Go to first candle" title="First candle">
            <ChevronFirst size={16} />
          </button>
          <button type="button" className="rbtn" onClick={() => session.step(-1)} disabled={atStart} aria-label="Step back one candle" title="Step back 1 candle">
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="rbtn rbtn--play" onClick={() => session.toggle()} disabled={!s.playing && atEnd} aria-label={s.playing ? 'Pause' : 'Play'} title={s.playing ? 'Pause' : 'Play'}>
            {s.playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button type="button" className="rbtn" onClick={() => session.step(1)} disabled={atEnd} aria-label="Step forward one candle" title="Step forward 1 candle">
            <ChevronRight size={16} />
          </button>
          <button type="button" className="rbtn" onClick={() => session.toEnd()} disabled={atEnd} aria-label="Go to last closed candle" title="Last closed candle">
            <ChevronLast size={16} />
          </button>
        </div>
        <div className="seg replay__speed" role="group" aria-label="Replay speed">
          {REPLAY_SPEEDS.map((v) => (
            <button key={v} type="button" className="seg__btn" aria-selected={s.speed === v} onClick={() => session.setSpeed(v)}>
              {v}x
            </button>
          ))}
        </div>
        <dl className="replay__read">
          <div><dt>Replay time</dt><dd data-testid="replay-time">{utc(s.knowledgeTime)}</dd></div>
          <div><dt>Visible</dt><dd className="num" data-testid="replay-count">{(s.cursor + 1).toLocaleString('en-US')} / {s.total.toLocaleString('en-US')}</dd></div>
          <div><dt>Timeframe</dt><dd>{s.timeframe}</dd></div>
        </dl>
        <div className="replay__actions">
          <button type="button" className="rbtn rbtn--text" onClick={() => void verify()} disabled={audit.running} title="Run the anti-repaint audit on the candles loaded for this replay">
            <ShieldCheck size={15} /> {audit.running ? `Verifying ${audit.progress}` : 'Verify no-repaint'}
          </button>
          <button type="button" className="rbtn rbtn--text rbtn--exit" onClick={onExit} title="Exit replay and return to live">
            <X size={15} /> Exit Replay
          </button>
        </div>
      </div>
      <div className="replay__row replay__row--seek">
        <input
          type="range"
          className="replay__scrub"
          min={0}
          max={Math.max(0, s.total - 1)}
          value={Math.max(0, s.cursor)}
          onChange={(e) => session.seek(Number(e.target.value))}
          aria-label="Replay position (candle)"
        />
        <form className="replay__jump" onSubmit={go}>
          <label>
            <span>Start at (UTC)</span>
            <input type="datetime-local" value={jump || toInput(s.barTime)} onChange={(e) => setJump(e.target.value)} />
          </label>
          <button type="submit" className="rbtn rbtn--text">Go</button>
        </form>
        <span className="replay__hint">Click a candle to jump there. Only closed candles up to the replay time exist for the engine.</span>
      </div>
      {audit.report && <AuditSummary report={audit.report} onClose={() => setAudit({ running: false, progress: '', report: null })} />}
    </div>
  );
}

function AuditSummary({ report, onClose }: { report: ReplayAuditReport; onClose: () => void }) {
  const violations = [...report.perTimeframe.flatMap((r) => r.violations), ...report.mtf.violations];
  return (
    <div className={`raudit ${report.passed ? 'is-pass' : 'is-fail'}`} data-testid="replay-audit">
      <div className="raudit__head">
        {report.passed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        <strong>{report.passed ? 'NO REPAINT DETECTED' : 'REPAINT / LOOKAHEAD DETECTED'}</strong>
        <span className="srmuted">
          {report.instrumentId} · {report.perTimeframe.reduce((a, r) => a + r.bars, 0).toLocaleString('en-US')} closed bars loaded · {report.ms} ms
        </span>
        <button type="button" className="rbtn rbtn--icon" onClick={onClose} aria-label="Close audit result">
          <X size={14} />
        </button>
      </div>
      <table className="raudit__table">
        <thead>
          <tr><th>TF</th><th>Bars</th><th>Zones</th><th>Touches</th><th>Breaks</th><th>Flips</th><th>Checks</th><th>Result</th></tr>
        </thead>
        <tbody>
          {report.perTimeframe.map((r) => (
            <tr key={r.timeframe}>
              <td>{r.timeframe}</td>
              <td className="num">{r.bars}</td>
              <td className="num">{r.zones}</td>
              <td className="num">{r.touches}</td>
              <td className="num">{r.breaks}</td>
              <td className="num">{r.flips}</td>
              <td className="num">{r.steps} steps · {r.checkpoints} prefix</td>
              <td className={r.violations.length ? 'bad' : 'ok'}>{r.violations.length ? `${r.violations.length} issue(s)` : 'PASS'}</td>
            </tr>
          ))}
          <tr>
            <td>MTF</td>
            <td colSpan={5} className="srmuted">replay vs fresh no-future analysis · {report.mtf.timeframe} clock</td>
            <td className="num">{report.mtf.points} points</td>
            <td className={report.mtf.violations.length ? 'bad' : 'ok'}>{report.mtf.violations.length ? `${report.mtf.violations.length} issue(s)` : 'PASS'}</td>
          </tr>
        </tbody>
      </table>
      {violations.length > 0 && (
        <ol className="raudit__list">
          {violations.slice(0, 20).map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
