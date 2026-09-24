import { CheckCircle2, ChevronLeft, ChevronRight, Pause, Play, RotateCcw, ShieldCheck, X, XCircle } from 'lucide-react';
import { useState } from 'react';
import { LIQUIDITY_REPLAY_SPEEDS, type LiquidityReplaySession } from '../../services/liquidity/LiquidityReplay';
import { runLiquidityAudit, type LiquidityAuditReport } from '../../services/liquidity/replayAudit';
import { useStore } from '../../store/createStore';
import { fmtUtc } from './format';

/** Liquidity replay transport (separate from S&R Replay). */
export function LiquidityReplayBar({ session, onExit }: { session: LiquidityReplaySession; onExit: () => void }) {
  const s = useStore(session.store, (x) => x);
  const [audit, setAudit] = useState<{ running: boolean; progress: string; report: LiquidityAuditReport | null }>({ running: false, progress: '', report: null });
  const atStart = s.cursor <= 0;
  const atEnd = s.cursor >= s.total - 1;
  const verify = async () => {
    session.pause();
    setAudit({ running: true, progress: '…', report: null });
    const report = await runLiquidityAudit(session.dataset, s.timeframe, (label, done, total) => setAudit((a) => ({ ...a, progress: `${label} (${done}/${total})` })));
    setAudit({ running: false, progress: '', report });
  };
  return (
    <div className="replay lqreplay" role="region" aria-label="Liquidity replay controls" data-testid="lq-replay-bar">
      <div className="replay__row">
        <span className="replay__badge">REPLAY</span>
        <div className="replay__transport" role="group" aria-label="Replay transport">
          <button type="button" className="rbtn" onClick={() => session.toStart()} disabled={atStart} aria-label="Reset to first candle" title="Reset">
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
          {LIQUIDITY_REPLAY_SPEEDS.map((v) => (
            <button key={v} type="button" className="seg__btn" aria-selected={s.speed === v} onClick={() => session.setSpeed(v)}>
              {v}x
            </button>
          ))}
        </div>
        <dl className="replay__read">
          <div><dt>Replay time</dt><dd data-testid="lq-replay-time">{fmtUtc(s.knowledgeTime)}</dd></div>
          <div><dt>Visible</dt><dd className="num" data-testid="lq-replay-count">{(s.cursor + 1).toLocaleString('en-US')} / {s.total.toLocaleString('en-US')}</dd></div>
          <div><dt>Timeframe</dt><dd>{s.timeframe}</dd></div>
        </dl>
        <div className="replay__actions">
          <button type="button" className="rbtn rbtn--text" onClick={() => void verify()} disabled={audit.running} title="Run the Liquidity anti-repaint audit on the candles loaded for this replay">
            <ShieldCheck size={15} /> {audit.running ? `Verifying ${audit.progress}` : 'Verify no-repaint'}
          </button>
          <button type="button" className="rbtn rbtn--text rbtn--exit" onClick={onExit}>
            <X size={15} /> Exit Replay
          </button>
        </div>
      </div>
      <div className="replay__row replay__row--seek">
        <input type="range" className="replay__scrub" min={0} max={Math.max(0, s.total - 1)} value={Math.max(0, s.cursor)} onChange={(e) => session.seek(Number(e.target.value))} aria-label="Replay position (candle)" />
        <span className="replay__hint">Click a candle to jump there. Pools, tests and sweep markers appear only once their candles have closed.</span>
      </div>
      {audit.report && (
        <div className={`raudit ${audit.report.passed ? 'is-pass' : 'is-fail'}`} data-testid="lq-audit">
          <div className="raudit__head">
            {audit.report.passed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            <strong>{audit.report.passed ? 'NO REPAINT DETECTED' : 'REPAINT / LOOKAHEAD DETECTED'}</strong>
            <span className="srmuted">
              {audit.report.instrumentId} · {audit.report.perTimeframe.reduce((a, r) => a + r.bars, 0).toLocaleString('en-US')} closed bars loaded · {audit.report.ms} ms
            </span>
            <button type="button" className="rbtn rbtn--icon" onClick={() => setAudit({ running: false, progress: '', report: null })} aria-label="Close audit result">
              <X size={14} />
            </button>
          </div>
          <table className="raudit__table">
            <thead>
              <tr><th>TF</th><th>Bars</th><th>Pools</th><th>EQ</th><th>Tests</th><th>Sweeps</th><th>Reclaims</th><th>Consumed</th><th>Result</th></tr>
            </thead>
            <tbody>
              {audit.report.perTimeframe.map((r) => (
                <tr key={r.timeframe}>
                  <td>{r.timeframe}</td>
                  <td className="num">{r.bars}</td>
                  <td className="num">{r.pools}</td>
                  <td className="num">{r.equalPools}</td>
                  <td className="num">{r.tests}</td>
                  <td className="num">{r.sweeps}</td>
                  <td className="num">{r.reclaims}</td>
                  <td className="num">{r.consumed}</td>
                  <td className={r.violations.length ? 'bad' : 'ok'}>{r.violations.length ? `${r.violations.length} issue(s)` : 'PASS'}</td>
                </tr>
              ))}
              <tr>
                <td>MTF</td>
                <td colSpan={7} className="srmuted">replay vs fresh no-future analysis · {audit.report.mtf.points} points</td>
                <td className={audit.report.mtf.violations.length ? 'bad' : 'ok'}>{audit.report.mtf.violations.length ? `${audit.report.mtf.violations.length} issue(s)` : 'PASS'}</td>
              </tr>
            </tbody>
          </table>
          {!audit.report.passed && (
            <ol className="raudit__list">
              {[...audit.report.perTimeframe.flatMap((r) => r.violations), ...audit.report.mtf.violations].slice(0, 20).map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
