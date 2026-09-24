import { X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { Level, Setup, StructureContext } from '../../engines/highLowEngine/types';
import { formatPrice, formatSigned } from '../../utils/format';
import { latestByType, LEVEL_ORDER, levelLabel, STATE_LABEL } from './hleView';
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
const Pill = ({ tone, children }: { tone: string; children: ReactNode }) => <span className={`hlepill hlepill--${tone}`}>{children}</span>;
const Bars = ({ v }: { v: number }) => (
  <span className="hlebars" aria-label={`${v} / 100`}>
    {[0, 1, 2, 3, 4].map((k) => <i key={k} className={v >= (k + 1) * 20 - 10 ? 'on' : ''} />)}
  </span>
);
const strengthTone = (s: string) => (s === 'STRONG' ? 'buy' : s === 'MEDIUM' ? 'warn' : 'neutral');

export function StageCards({ h4, levels, setup, d, tz, onViewLevels }: { h4: StructureContext | null; levels: readonly Level[]; setup: Setup | null; d: number; tz: string; onViewLevels: () => void }) {
  const s = setup;
  const buy = s?.side === 'BUY';
  const by = latestByType(levels);
  const liq = !s ? 'WAITING' : s.reclaim ? `${s.side} SETUP` : s.sweep ? (s.state === 'INVALIDATED' ? 'INVALIDATED' : 'SWEPT') : s.state === 'LIQUIDITY_APPROACH' ? 'APPROACHING' : 'WATCHING';
  return (
    <div className="hlestages">
      <Stage n={1} title="H4 DIRECTION" tone="h4" testId="hle-card-h4" badge={<Pill tone={h4?.bias === 'BULLISH' ? 'buy' : h4?.bias === 'BEARISH' ? 'sell' : 'neutral'}>{h4 ? h4.bias.replace('_', ' ') : 'NO DATA'}</Pill>} foot={h4 && h4.bias !== 'INSUFFICIENT_DATA' && h4.bias !== 'NEUTRAL' ? `Context only · main bias favours ${h4.bias === 'BEARISH' ? 'SELL' : 'BUY'} setups; reversals against it are flagged counter-trend.` : 'Context only — never creates or blocks a setup.'}>
        <Row k="Structure">{h4?.structure ?? '—'}</Row>
        <Row k="Last swing high">{h4?.lastSwingHigh ? formatPrice(h4.lastSwingHigh.price, d) : '—'}</Row>
        <Row k="Last swing low">{h4?.lastSwingLow ? formatPrice(h4.lastSwingLow.price, d) : '—'}</Row>
        <Row k="Trend strength">{h4 && h4.bias !== 'INSUFFICIENT_DATA' ? <Bars v={h4.strength} /> : '—'}</Row>
      </Stage>
      <Stage n={2} title="H1 HIGH / LOW ZONES" tone="h1" testId="hle-card-h1">
        {LEVEL_ORDER.map((t) => {
          const l = by[t];
          return (
            <div className={`hlestage__lvl ${l && l.status !== 'ACTIVE' ? 'is-off' : ''}`} key={t} data-testid={`hle-level-${t}`}>
              <span>{levelLabel(t)}</span>
              <strong className="num">{l ? formatPrice(l.price, d) : '—'}</strong>
              {l ? <Pill tone={strengthTone(l.strength)}>{l.strength}</Pill> : <span />}
            </div>
          );
        })}
        <button type="button" className="hlestage__all" onClick={onViewLevels}>View All Levels →</button>
      </Stage>
      <Stage n={3} title="M15 LIQUIDITY SETUP" tone="m15" testId="hle-card-m15" badge={s && <Pill tone={s.reclaim ? 'buyish' : s.sweep ? 'warn' : 'neutral'}>{liq}</Pill>} foot="This card can never confirm a trade on its own. M5 structure decides.">
        <Row k="Near level">{s ? `${formatPrice(s.level, d)} (${levelLabel(s.levelType)})` : '—'}</Row>
        <Row k={`${buy ? 'SSL' : 'BSL'} sweep`}>{s?.sweep ? `${formatPrice(s.sweep.extreme, d)} · ${s.sweep.penetrationAtr.toFixed(2)} ATR` : '—'}</Row>
        <Row k="Rejection">{s?.sweep ? `${Math.round(s.sweep.rejection * 100)}% wick` : '—'}</Row>
        <Row k="Reclaim">{s?.reclaim ? `Reclaimed · ${s.reclaim.bars} bar${s.reclaim.bars > 1 ? 's' : ''}` : s?.sweep ? (s.state === 'INVALIDATED' ? 'Not reclaimed' : 'Pending') : '—'}</Row>
        <Row k="Setup quality">{s ? <Bars v={s.score.total} /> : '—'}</Row>
      </Stage>
      <Stage n={4} title="M5 CONFIRMATION" tone="m5" testId="hle-card-m5" badge={s && <Pill tone={s.m5 ? 'buyish' : 'neutral'}>{s.m5 ? 'CONFIRMED' : s.reclaim && s.state === 'WAITING_M5' ? 'WAITING' : 'WAIT'}</Pill>} foot="No closed candle, no confirmation.">
        <Row k="CHOCH / BOS">{s?.m5 ? `${s.m5.kind} @ ${formatPrice(s.m5.close, d)}` : '—'}</Row>
        <Row k="Displacement">{s?.m5 ? `${s.m5.displacement.strong ? 'Yes' : 'No'} · ${s.m5.displacement.legAtr.toFixed(2)} ATR leg · ${s.m5.displacement.breakBodyAtr.toFixed(2)} ATR body` : '—'}</Row>
        <Row k="Candle close">{s?.m5 ? 'Confirmed on close' : '—'}</Row>
        <Row k="Structure">{s?.m5 ? `${buy ? 'Bullish' : 'Bearish'} ${s.m5.kind} through ${formatPrice(s.m5.brokenLevel, d)}` : '—'}</Row>
        <Row k="Confirmed at">{s?.m5 ? fmtShort(s.m5.knownAt, tz) : '—'}</Row>
      </Stage>
      <Stage n={5} title="M1 ENTRY" tone="m1" testId="hle-card-m1" badge={s && <Pill tone={s.state === 'ENTRY_READY' ? 'buy' : s.entry ? 'neutral' : 'neutral'}>{s.state === 'ENTRY_READY' ? 'CONFIRMED' : s.entry ? STATE_LABEL[s.state] : s.m5 ? 'SCANNING' : 'WAIT'}</Pill>} foot="M1 is read only after M5 confirms. It never sets a direction.">
        <Row k="Pullback">{s?.pullback ? 'Detected' : s?.m5 ? 'Waiting' : '—'}</Row>
        <Row k="FVG / OB">{s?.zone ? (s.zone.source === 'RECLAIM' ? 'None — reclaim band' : s.zone.source) : '—'}</Row>
        <Row k="Entry zone" testId="hle-card-m1-zone">{s?.zone ? `${formatPrice(s.zone.low, d)} – ${formatPrice(s.zone.high, d)}` : '—'}</Row>
        <Row k="SL (ATR)">{s?.risk ? formatPrice(s.risk.stop, d) : '—'}</Row>
        <Row k="TP1 / TP2">{s?.risk ? `${s.risk.tp1 === null ? '—' : formatPrice(s.risk.tp1, d)} / ${s.risk.tp2 === null ? '—' : formatPrice(s.risk.tp2, d)}` : '—'}</Row>
        <Row k="R:R">{s?.risk?.rr1 != null ? `1 : ${s.risk.rr1.toFixed(1)}` : '—'}</Row>
      </Stage>
    </div>
  );
}

/** Every level the engine holds: source, price, creation time, strength, state and distance. */
export function LevelsDialog({ levels, d, tz, onClose }: { levels: readonly Level[]; d: number; tz: string; onClose: () => void }) {
  const [onlyActive, setOnlyActive] = useState(true);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const rows = [...levels].filter((l) => !onlyActive || l.status === 'ACTIVE').sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="hlemodal" role="dialog" aria-modal="true" aria-label="All H1 levels" data-testid="hle-levels-dialog" onClick={onClose}>
      <div className="panel hlemodal__box" onClick={(e) => e.stopPropagation()}>
        <header className="hlemodal__head">
          <h2>All H1 levels</h2>
          <label className="hlemodal__chk">
            <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> Active only
          </label>
          <button type="button" className="rbtn rbtn--icon" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </header>
        <div className="srtable-wrap">
          <table className="srtable hlelevels">
            <thead>
              <tr><th>Source</th><th className="num-col">Price</th><th>Created</th><th>Strength</th><th>State</th><th className="num-col">Distance</th></tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td>{levelLabel(l.type)}</td>
                  <td className="num">{formatPrice(l.price, d)}</td>
                  <td>{fmtShort(l.createdAt, tz)}</td>
                  <td><Pill tone={strengthTone(l.strength)}>{l.strength}</Pill></td>
                  <td>{l.status}</td>
                  <td className="num">{formatSigned(l.distance, d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="srtable__none">No levels yet — they appear only from closed H1 candles.</p>}
        </div>
      </div>
    </div>
  );
}
