import { CheckCircle2, ListChecks, ScrollText, Target } from 'lucide-react';
import { useState } from 'react';
import { HLE_SCORE_WEIGHTS } from '../../engines/highLowEngine/config';
import type { HLEEvent, HLEScoreKey, Setup } from '../../engines/highLowEngine/types';
import { formatPrice } from '../../utils/format';
import { nextRequired, sequence } from './hleView';
import { fmtShort } from './useHighLow';

export function SetupSequence({ s, d }: { s: Setup | null; d: number }) {
  const seq = sequence(s);
  const buy = seq.side === 'BUY';
  return (
    <section className="panel hlebottom" aria-labelledby="hleseq-t" data-testid="hle-sequence">
      <h2 id="hleseq-t" className="hlebottom__title"><ListChecks size={15} aria-hidden="true" /> SETUP SEQUENCE</h2>
      <p className={`hleseq__side ${buy ? 'is-buy' : 'is-sell'}`}>{buy ? '▲ BUY (From Low)' : '▼ SELL (From High)'}</p>
      <ol className="hleseq">
        {seq.steps.map((x, k) => (
          <li key={x.label} className={`hleseq__step is-${x.status}`}>
            <span className="hleseq__n">{x.status === 'done' ? <CheckCircle2 size={13} /> : k + 1}</span>
            <span>{x.label}</span>
          </li>
        ))}
      </ol>
      {s && <p className="hlenext" data-testid="hle-next"><span>Next:</span> {nextRequired(s, d)}</p>}
    </section>
  );
}

const LABEL: Record<HLEScoreKey, string> = {
  htfAlignment: 'HTF Alignment',
  levelImportance: 'Level Importance',
  sweepQuality: 'Sweep Quality',
  rejectionDisplacement: 'Rejection / Displacement',
  m5Structure: 'M5 Structure',
  m1EntryQuality: 'M1 Entry Quality',
  fvgObConfluence: 'FVG / OB Confluence',
};

export function SetupScore({ s }: { s: Setup | null }) {
  const total = s?.score.total ?? null;
  const keys = Object.keys(HLE_SCORE_WEIGHTS) as HLEScoreKey[];
  return (
    <section className="panel hlebottom" aria-labelledby="hlescore-t">
      <h2 id="hlescore-t" className="hlebottom__title"><Target size={15} aria-hidden="true" /> SETUP SCORE</h2>
      <div className="hlescore">
        <div className="hlering" aria-label={total === null ? 'No setup' : `Score ${total} of 100`}>
          <svg viewBox="0 0 42 42" aria-hidden="true">
            <circle cx="21" cy="21" r="17" className="hlering__bg" />
            <circle cx="21" cy="21" r="17" className="hlering__fg" strokeDasharray={`${((total ?? 0) / 100) * 106.8} 106.8`} />
          </svg>
          <strong className="num">{total ?? '—'}</strong>
          <span>/ 100</span>
        </div>
        <table className="hlescore__t" data-testid="hle-score">
          <tbody>
            {keys.map((k) => (
              <tr key={k} data-testid={`hle-score-${k}`}>
                <td>{LABEL[k]} <span className="srmuted">({HLE_SCORE_WEIGHTS[k]}%)</span></td>
                <td className="num">{s ? `${s.score.contributions[k].toFixed(1).replace(/\.0$/, '')}/${HLE_SCORE_WEIGHTS[k]}` : `—/${HLE_SCORE_WEIGHTS[k]}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hlenote">Weights total 100%. Descriptive quality — not a win probability. A high score never bypasses a missing mandatory stage.</p>
    </section>
  );
}

const DOT: Partial<Record<HLEEvent['type'], string>> = { ENTRY_READY: 'ok', SETUP_INVALIDATED: 'bad', SETUP_EXPIRED: 'muted', H4_BIAS_CHANGED: 'blue', H1_BIAS_CHANGED: 'blue', M5_CHOCH: 'purple', M5_BOS: 'purple' };

export function SignalLog({ log, d, tz, onSelect }: { log: readonly HLEEvent[]; d: number; tz: string; onSelect: (setupId: string) => void }) {
  const [all, setAll] = useState(false);
  const rows = [...log].reverse().slice(0, all ? 300 : 40);
  return (
    <section className="panel hlebottom" aria-labelledby="hlelog-t">
      <h2 id="hlelog-t" className="hlebottom__title">
        <ScrollText size={15} aria-hidden="true" /> SIGNAL LOG <span className="hlelog__badge">stored in this browser · {log.length} events</span>
        <button type="button" className="hlelog__all" onClick={() => setAll((v) => !v)}>{all ? 'Show recent' : 'View all →'}</button>
      </h2>
      <ol className="hlelog" data-testid="hle-log">
        {rows.map((e) => (
          <li key={e.id}>
            <button type="button" onClick={() => e.setupId && onSelect(e.setupId)} disabled={!e.setupId}>
              <span className="hlelog__t">{fmtShort(e.time, tz)}</span>
              <i className={`hlelog__dot is-${DOT[e.type] ?? 'gold'}`} aria-hidden="true" />
              <span className="hlelog__m">
                <strong>{e.type.replace(/_/g, ' ')}</strong> · {e.timeframe}
                {e.price !== null && <> · <span className="num">{formatPrice(e.price, d)}</span></>} — {e.message}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {rows.length === 0 && <p className="srtable__none">No events yet.</p>}
    </section>
  );
}
