import type { H4Context, KeyLevel, Setup } from '../../engines/hlReversal/types';
import { formatPrice } from '../../utils/format';
import { STATE_LABEL } from './hlrView';

const Row = ({ k, children, testId }: { k: string; children: React.ReactNode; testId?: string }) => (
  <div className="hlrcard__row" data-testid={testId}>
    <span>{k}</span>
    <strong className="num">{children}</strong>
  </div>
);
export const DirBadge = ({ dir }: { dir: 'BUY' | 'SELL' }) => <span className={`hlrdir hlrdir--${dir.toLowerCase()}`}>{dir}</span>;
export const StateBadge = ({ s }: { s: Setup }) => <span className={`hlrst hlrst--${s.entryStatus.toLowerCase()}`}>{STATE_LABEL[s.state]}</span>;

function Card({ n, title, badge, tone, children, testId }: { n: number; title: string; badge?: React.ReactNode; tone: string; children: React.ReactNode; testId: string }) {
  return (
    <section className={`panel hlrcard hlrcard--${tone}`} aria-label={title} data-testid={testId}>
      <header className="hlrcard__head">
        <span className="hlrcard__n">{n}.</span>
        <h3>{title}</h3>
        {badge}
      </header>
      <div className="hlrcard__body">{children}</div>
    </section>
  );
}

function Strength({ v }: { v: number }) {
  return (
    <span className="hlrstrength" aria-label={`${v} / 100`}>
      {[0, 1, 2, 3, 4].map((k) => (
        <i key={k} className={v >= (k + 1) * 20 - 10 ? 'on' : ''} />
      ))}
    </span>
  );
}

/** The five-stage workflow — every value from the engine result; "—" when the stage has no evidence yet. */
export function HLRCards({ h4, levels, setup, price, d }: { h4: H4Context | null; levels: readonly KeyLevel[]; setup: Setup | null; price: number | null; d: number }) {
  const liveLevels = levels.filter((l) => l.status === 'ACTIVE' || l.status === 'TESTED');
  const keyHigh = liveLevels.filter((l) => l.side === 'high' && (price === null || l.price >= price)).sort((a, b) => a.price - b.price)[0] ?? null;
  const keyLow = liveLevels.filter((l) => l.side === 'low' && (price === null || l.price <= price)).sort((a, b) => b.price - a.price)[0] ?? null;
  const s = setup;
  const buy = s?.direction === 'BUY';
  const h4Tone = !h4 || h4.state === 'INSUFFICIENT_DATA' || h4.state === 'NEUTRAL' ? 'neutral' : h4.state === 'BULLISH' ? 'buy' : 'sell';
  return (
    <div className="hlrcards" role="list" aria-label="Reversal workflow">
      <Card n={1} title="H4 DIRECTION" tone="h4" testId="hlr-card-h4" badge={<span className={`hlrpill hlrpill--${h4Tone}`}>{h4 ? h4.state.replace('_', ' ') : 'NO DATA'}</span>}>
        <Row k="Structure">{h4?.structure ?? '—'}</Row>
        <Row k="Last swing high">{h4?.lastSwingHigh ? formatPrice(h4.lastSwingHigh.price, d) : '—'}</Row>
        <Row k="Last swing low">{h4?.lastSwingLow ? formatPrice(h4.lastSwingLow.price, d) : '—'}</Row>
        <Row k="Trend strength">{h4 && h4.state !== 'INSUFFICIENT_DATA' ? <Strength v={h4.strength} /> : '—'}</Row>
        {s?.counterTrend && <p className="hlrcard__note">Selected {s.direction} setup is counter-trend (context only).</p>}
      </Card>
      <Card n={2} title="H1 HIGH / LOW ZONES" tone="h1" testId="hlr-card-h1">
        <Row k="Key high (BSL above)">{keyHigh ? formatPrice(keyHigh.price, d) : '—'}{keyHigh && <span className="hlrsig">sig {keyHigh.significance}</span>}</Row>
        <Row k="Key low (SSL below)">{keyLow ? formatPrice(keyLow.price, d) : '—'}{keyLow && <span className="hlrsig">sig {keyLow.significance}</span>}</Row>
        <Row k="Selected level">{s ? `${buy ? 'Low' : 'High'} ${formatPrice(s.level, d)}${s.levelEquals ? ` · equal ×${s.levelEquals + 1}` : ''}` : '—'}</Row>
        <Row k="Range (high − low)">{keyHigh && keyLow ? formatPrice(keyHigh.price - keyLow.price, d) : '—'}</Row>
      </Card>
      <Card n={3} title="M15 LIQUIDITY SETUP" tone="m15" testId="hlr-card-m15" badge={s && <span className={`hlrpill hlrpill--${s.reclaim ? 'buyish' : s.sweep ? 'warn' : 'neutral'}`}>{s.liquidity === 'NONE' ? 'WAITING' : s.liquidity.replace('_', ' ')}</span>}>
        <Row k={`${buy ? 'SSL' : 'BSL'} sweep extreme`}>{s?.sweep ? formatPrice(s.sweep.extreme, d) : '—'}</Row>
        <Row k="Penetration">{s?.sweep ? `${formatPrice(s.sweep.penetration, d)} (${s.sweep.penetrationAtr.toFixed(2)} ATR)` : '—'}</Row>
        <Row k="Reclaim close">{s?.reclaim ? `${formatPrice(s.reclaim.price, d)} · ${s.reclaim.bars} bar${s.reclaim.bars > 1 ? 's' : ''}` : '—'}</Row>
        <Row k="Distance from level">{s?.reclaim ? formatPrice(s.reclaim.distance, d) : '—'}</Row>
      </Card>
      <Card n={4} title="M5 CONFIRMATION" tone="m5" testId="hlr-card-m5" badge={s && <span className={`hlrpill hlrpill--${s.m5 ? 'blue' : 'neutral'}`}>{s.m5 ? `${s.m5.kind} CONFIRMED` : s.reclaim ? 'PENDING' : 'WAIT'}</span>}>
        <Row k="CHOCH / BOS">{s?.m5 ? `${s.m5.kind} ${buy ? 'up' : 'down'}` : '—'}</Row>
        <Row k="Broken structure">{s?.m5 ? formatPrice(s.m5.brokenLevel, d) : '—'}</Row>
        <Row k="Displacement">{s?.m5 ? `${s.m5.displacement.legAtr.toFixed(2)} ATR · body ${s.m5.displacement.maxBodyAtr.toFixed(2)} ATR` : '—'}</Row>
        <Row k="Confirmation close">{s?.m5 ? formatPrice(s.m5.close, d) : '—'}</Row>
      </Card>
      <Card n={5} title="M1 ENTRY" tone="m1" testId="hlr-card-m1" badge={s && <StateBadge s={s} />}>
        <Row k="Entry zone" testId="hlr-card-m1-zone">{s?.zone ? `${formatPrice(s.zone.low, d)} – ${formatPrice(s.zone.high, d)}` : '—'}</Row>
        <Row k="SL">{s?.risk ? formatPrice(s.risk.stop, d) : '—'}</Row>
        <Row k="TP1 / TP2">{s?.risk ? `${formatPrice(s.risk.tp1, d)} / ${s.risk.tp2 === null ? '—' : formatPrice(s.risk.tp2, d)}` : '—'}</Row>
        <Row k="R:R (TP1)">{s?.risk ? `1 : ${s.risk.rr1.toFixed(1)}` : '—'}</Row>
      </Card>
    </div>
  );
}
