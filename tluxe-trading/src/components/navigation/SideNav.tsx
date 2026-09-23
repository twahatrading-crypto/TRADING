import {
  BarChart3,
  BookOpen,
  BrainCircuit,
  CalendarDays,
  ChevronDown,
  Cpu,
  LayoutDashboard,
  LineChart,
  Newspaper,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useHashRoute } from '../../hooks/useHashRoute';
import './nav.css';

interface NavItem {
  label: string;
  icon?: LucideIcon;
  /** Hash path; undefined = not built yet (rendered disabled). */
  href?: string;
}

const MAIN: NavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, href: '#/' },
  { label: 'Market', icon: LineChart, href: '#/market-overview' },
  { label: 'Analysis', icon: BarChart3 },
];

const ENGINE_ITEMS: NavItem[] = [
  { label: 'Support & Resistance', href: '#/engines/support-resistance' },
  { label: 'Liquidity' },
  { label: 'Order Blocks' },
  { label: 'FVG' },
  { label: 'Market Structure' },
  { label: 'Sessions' },
  { label: 'Multi-Timeframe' },
  { label: 'Backtest' },
];

const SECONDARY: NavItem[] = [
  { label: 'Journal', icon: BookOpen, href: '#/trading-journal' },
  { label: 'Risk Management', icon: ShieldCheck, href: '#/risk-management' },
  { label: 'Calendar', icon: CalendarDays, href: '#/economic-calendar' },
  { label: 'News', icon: Newspaper },
  { label: 'AI Assistant', icon: BrainCircuit },
  { label: 'Settings', icon: Settings, href: '#/settings' },
];

function Item({ item, current, nested }: { item: NavItem; current: string; nested?: boolean }) {
  const Icon = item.icon;
  const active = item.href === `#${current}`;
  const body = (
    <>
      {Icon && <Icon size={17} aria-hidden="true" />}
      <span className="snav__label">{item.label}</span>
      {!item.href && <span className="snav__soon">Soon</span>}
    </>
  );
  const cls = `snav__item ${nested ? 'snav__item--nested' : ''} ${active ? 'is-active' : ''}`;
  return item.href ? (
    <a className={cls} href={item.href} aria-current={active ? 'page' : undefined} title={item.label}>
      {body}
    </a>
  ) : (
    <span className={`${cls} is-disabled`} aria-disabled="true" title={`${item.label} — not built yet`}>
      {body}
    </span>
  );
}

export function SideNav({ open, onNavigate }: { open?: boolean; onNavigate?: () => void }) {
  const route = useHashRoute();
  const inEngines = route.startsWith('/engines');
  return (
    <nav className={`snav ${open ? 'is-open' : ''}`} aria-label="Main navigation" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      {MAIN.map((i) => (
        <Item key={i.label} item={i} current={route} />
      ))}
      <div className={`snav__group ${inEngines ? 'is-active' : ''}`}>
        <div className="snav__item snav__group-head" title="Engines">
          <Cpu size={17} aria-hidden="true" />
          <span className="snav__label">Engines</span>
          <ChevronDown size={14} className="snav__chev" aria-hidden="true" />
        </div>
        <div className="snav__sub">
          {ENGINE_ITEMS.map((i) => (
            <Item key={i.label} item={i} current={route} nested />
          ))}
        </div>
      </div>
      {SECONDARY.map((i) => (
        <Item key={i.label} item={i} current={route} />
      ))}
    </nav>
  );
}
