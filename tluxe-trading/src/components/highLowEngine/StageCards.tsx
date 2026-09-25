import { X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { HLEDecision } from '../../engines/highLowEngine/decision';
import type { Level, Setup, StructureContext } from '../../engines/highLowEngine/types';
import { formatPrice, formatSigned } from '../../utils/format';
import { HEADLINE, headline } from './hleView';
import { fmtShort } from './useHighLow';

const Row = ({ k, children, testId }: { k: string; children: ReactNode; testId?: string }) => (
  <div className="hlestage__row" data-testid={testId}>
    <span>{k}</span>
    <strong className="num">{children}</strong>
  </div>
);
function Stage({ n, title, tone, badge, foot, children, testId }: { n: number; title: string; tone: string; badge?: ReactNode; foot?: string; children: ReactNode; testId: string }) {
  return (
    <section className={`panel hlestage hlestage--${tone}`} aria-label={title} data-testid={testId}>
      <header className="hlestage__head">
        <h3>
          <span>{n}.</span> {title}
        </h3>
        {badge}
      </header>
      <div className="hlestage__body">{children}</div>
      {foot && <p className="hlestage__foot">{foot}</p>}
    </section>
  );
}
export const Pill = ({ tone, children }: { tone: string; children: ReactNode }) => <span className={`hlepill hlepill--${tone}`}>{children}</span>;
const Bars = ({ v }: { v: number }) => (
  <span className="hlebars" aria-label={`${Math.round(v * 100)}%`}>
    {[0, 1, 2, 3, 4].map((k) => <i key={k} className={v >= (k + 1) * 0.2 - 0.1 ? 'on' : ''} />)}
  </span>
);
const ratingTone = (s: string) => (s === 'STRONG' ? 'buy' : s === 'MEDIUM' ? 'warn' : 'neutral');
const biasTone = (b?: string) => (b === 'BULLISH' ? 'buy' : b === 'BEARISH' ? 'sell' : 'neutral');

interface Props {
  h4: StructureContext | null;
  levels: readonly Level[];
  decision: HLEDecision | null;
  setup: Setup | null;
  d: number;
  tz: string;
  onViewLevels: () => void;
}

/** The five numbered strategy cards (handoff §12.2) — card-shaped views of the SAME engine evidence. */
export function StageCards({ h4, levels, decision, setup, d, tz, onViewLevels }: Props) {
  const s = setup;
  const buy = (s?.side ?? decision?.direction ?? 'BUY') === 'BUY';
  const lvl = decision?.level ?? null;
  const heads = headline(levels);
  const t = decision?.tradeLevels ?? null;
  const code = decision?.code;
  const m15Status = !s
    ? code === 'WAITING_SWEEP'
      ? 'WATCHING'
      : code === 'TOO_FAR'
        ? 'TOO FAR'
        : code === 'NO_DATA'
          ? 'NO DATA'
          : 'WAITING'
    : s.code === 'LEVEL_BROKEN'
      ? 'LEVEL BROKEN'
      : s.reclaim
        ? `${s.side} SETUP`
        : s.state === 'INVALIDATED'
          ? 'INVALIDATED'
          : 'SWEPT';
  const withheld = !t && s?.risk ? (decision?.signalsLive ? 'withheld' : 'withheld — feed not live') : '—';
  return (
    <div className="hlestages">
      <Stage
        n={1}
        title="H4 DIRECTION"
        tone="h4"
        testId="hle-card-h4"
        badge={<Pill tone={biasTone(h4?.bias)}>{h4 ? (h4.bias === 'INSUFFICIENT_DATA' ? 'WAITING FOR DATA' : h4.bias) : 'NO DATA'}</Pill>}
        foot={h4 && h4.dir !== 0 ? `Context only — scored, never a gate. A ${h4.dir < 0 ? 'BUY' : 'SELL'} here is counter-trend and labelled.` : 'Context only — never creates or blocks a setup.'}
      >
        <Row k="Structure">{h4?.structure ?? '—'}</Row>
        <Row k="Last swing high">{h4?.lastSwingHigh ? formatPrice(h4.lastSwingHigh.price, d) : '—'}</Row>
        <Row k="Last swing low">{h4?.lastSwingLow ? formatPrice(h4.lastSwingLow.price, d) : '—'}</Row>
        <Row k="Trend strength">{h4?.strength ? <><Bars v={h4.strength.value} /> {h4.strength.agree}/{h4.strength.total}</> : '—'}</Row>
      </Stage>
      <Stage n={2} title="H1 HIGH / LOW ZONES" tone="h1" testId="hle-card-h1">
        {HEADLINE.map((h) => {
          const l = heads[h.key];
          return (
            <div className={`hlestage__lvl ${l && l.state === 'CONSUMED' ? 'is-off' : ''}`} key={h.key} data-testid={`hle-level-${h.key}`}>
              <span>{h.label}</span>
              <strong className="num">{l ? formatPrice(l.price, d) : '—'}</strong>
              {l ? <Pill tone={ratingTone(l.rating.label)}>{l.rating.label}</Pill> : <span />}
            </div>
          );
        })}
        <button type="button" className="hlestage__all" onClick={onViewLevels}>View All Levels →</button>
      </Stage>
      <Stage
        n={3}
        title="M15 LIQUIDITY SETUP"
        tone="m15"
        testId="hle-card-m15"
        badge={<Pill tone={s?.reclaim ? 'buyish' : s?.state === 'INVALIDATED' ? 'sell' : s ? 'warn' : 'neutral'}>{m15Status}</Pill>}
        foot="A sweep can never confirm a trade on its own. M5 structure decides."
      >
        <Row k="Level">{s ? `${formatPrice(s.level, d)} (${s.levelLabel})` : lvl ? `${formatPrice(lvl.price, d)} (${lvl.label})` : '—'}</Row>
        <Row k="Distance">{lvl?.distanceAtr != null ? `${lvl.distanceAtr.toFixed(2)} ATR ${lvl.near ? '· watching (≤ 2.0)' : '· too far (> 2.0)'}` : '—'}</Row>
        <Row k={`${buy ? 'SSL' : 'BSL'} sweep`}>{s ? `${formatPrice(s.sweep.extreme, d)} · ${s.sweep.penetrationAtr.toFixed(2)} ATR` : '—'}</Row>
        <Row k="Rejection">{s ? `${Math.round(s.sweep.wick * 100)}% wick · ${s.sweep.rejection ? 'yes' : 'no'}` : '—'}</Row>
        <Row k="Reclaim">{s?.reclaim ? `Close back ${buy ? 'above' : 'below'} · ${s.reclaim.bars} bar${s.reclaim.bars > 1 ? 's' : ''}` : s ? (s.code === 'LEVEL_BROKEN' ? 'Not reclaimed (break)' : 'Pending (≤ 4 M15 closes)') : '—'}</Row>
        <Row k="Quality">{s ? <><Bars v={s.score.total / 100} /> {s.score.total}</> : '—'}</Row>
      </Stage>
      <Stage n={4} title="M5 CONFIRMATION" tone="m5" testId="hle-card-m5" badge={<Pill tone={s?.m5 ? 'buyish' : 'neutral'}>{s?.m5 ? 'CONFIRMED' : 'WAITING'}</Pill>} foot="No closed candle, no confirmation.">
        <Row k="CHOCH / BOS">{s?.m5 ? `${buy ? 'Bullish' : 'Bearish'} ${s.m5.kind} from ${s.m5.preBias.toLowerCase()} M5 structure` : '—'}</Row>
        <Row k="Displacement">{s?.m5 ? `${s.m5.displacement.displaced ? 'Yes' : 'No'} · body ${s.m5.displacement.bodyAtr.toFixed(2)} ATR · ${Math.round(s.m5.displacement.bodyPct * 100)}% of range` : '—'}</Row>
        <Row k="Candle close">{s?.m5 ? 'Confirmed on close' : 'Required'}</Row>
        <Row k="Broken swing">{s?.m5 ? `${formatPrice(s.m5.brokenLevel, d)}${s.m5.preSweepSwing ? ' (pre-sweep swing)' : ''}` : '—'}</Row>
        <Row k="Confirmed at">{s?.m5 ? fmtShort(s.m5.knownAt, tz) : '—'}</Row>
      </Stage>
      <Stage
        n={5}
        title="M1 ENTRY"
        tone="m1"
        testId="hle-card-m1"
        badge={<Pill tone={decision?.confirmed ? 'buy' : 'neutral'}>{decision?.confirmed ? 'CONFIRMED' : s?.state === 'NO_TARGET' ? 'NO TARGET' : s?.entry ? 'WITHHELD' : s?.m5 ? 'SCANNING' : 'WAIT'}</Pill>}
        foot="M1 is read only after M5 confirms. It never sets a direction."
      >
        <Row k="Pullback">{s?.entry ? `Into the zone · ${fmtShort(s.entry.knownAt, tz)}` : s?.m5 ? 'Waiting (≤ 180 M1 bars)' : '—'}</Row>
        <Row k="FVG / OB">{s?.confluence ? `${s.confluence.fvg.length ? 'FVG' : ''}${s.confluence.fvg.length && s.confluence.ob.length ? ' + ' : ''}${s.confluence.ob.length ? 'OB' : ''}` || 'None' : '—'}</Row>
        <Row k="Entry zone (0.5–0.786)" testId="hle-card-m1-zone">{s?.zone ? `${formatPrice(s.zone.low, d)} – ${formatPrice(s.zone.high, d)}` : '—'}</Row>
        <Row k="SL">{s?.zone ? formatPrice(s.zone.stop, d) : '—'}</Row>
        <Row k="Entry">{t ? formatPrice(t.entry, d) : withheld}</Row>
        <Row k="TP1 / TP2">{t ? `${formatPrice(t.tp1, d)} / ${t.tp2 === null ? '—' : formatPrice(t.tp2, d)}` : withheld}</Row>
        <Row k="R:R">{t ? `1 : ${t.rr1.toFixed(2)}${t.belowMinRR ? ' (below 1.5 — reported only)' : ''}` : withheld}</Row>
      </Stage>
    </div>
  );
}

/** Every level the engine holds: source, price, validity, rating, state, touches and distance. */
export function LevelsDialog({ levels, d, tz, onClose }: { levels: readonly Level[]; d: number; tz: string; onClose: () => void }) {
  const [onlyActive, setOnlyActive] = useState(true);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const rows = [...levels].filter((l) => l.retiredAt === null && (!onlyActive || l.state !== 'CONSUMED')).sort((a, b) => b.price - a.price);
  return (
    <div className="hlemodal" role="dialog" aria-modal="true" aria-label="All H1 levels" data-testid="hle-levels-dialog" onClick={onClose}>
      <div className="panel hlemodal__box" onClick={(e) => e.stopPropagation()}>
        <header className="hlemodal__head">
          <h2>All H1 levels</h2>
          <label className="hlemodal__chk">
            <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> Hide consumed
          </label>
          <button type="button" className="rbtn rbtn--icon" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </header>
        <div className="srtable-wrap">
          <table className="srtable hlelevels">
            <thead>
              <tr><th>Source</th><th className="num-col">Price</th><th>Valid from</th><th>Rating</th><th>State</th><th className="num-col">Touches</th><th className="num-col">Distance</th></tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td>{l.label}</td>
                  <td className="num">{formatPrice(l.price, d)}</td>
                  <td>{fmtShort(l.validFrom, tz)}</td>
                  <td><Pill tone={ratingTone(l.rating.label)}>{l.rating.label}</Pill> <span className="srmuted">{l.rating.score.toFixed(2)}</span></td>
                  <td>{l.state}</td>
                  <td className="num">{l.touches}</td>
                  <td className="num">{l.distance === null ? '—' : formatSigned(l.distance, d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="srtable__none">No levels yet — they appear only from closed H1 candles (≥ 40).</p>}
        </div>
      </div>
    </div>
  );
}
