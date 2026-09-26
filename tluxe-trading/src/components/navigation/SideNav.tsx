import {
  ArrowDownUp,
  ArrowLeftRight,
  BarChart3,
  Boxes,
  Brain,
  ChevronRight,
  Diamond,
  Droplets,
  Flame,
  Footprints,
  Layers,
  LayoutDashboard,
  LineChart,
  Newspaper,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { SETTINGS_ROUTE } from '../../config/modules';
import { DASHBOARD_ROUTE, STRATEGY_NAV, type StrategyIcon } from '../../config/navigation';
import { useHashRoute } from '../../hooks/useHashRoute';
import { usePersistentState } from '../../hooks/usePersistentState';
import { LogoMark } from '../branding/Logo';
import { BRAND } from '../../config/branding';
import './nav.css';

const STRATEGY_ICONS: Record<StrategyIcon, LucideIcon> = {
  sr: Layers,
  liquidity: Droplets,
  orderBlocks: Boxes,
  hlr: ArrowDownUp,
  hle: Diamond,
  heatmap: Flame,
  smc: Brain,
  volumeProfile: BarChart3,
  footprint: Footprints,
  news: Newspaper,
  sweep: ArrowLeftRight,
};

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

function NavLink({ route, current, icon: Icon, label, nested }: { route: string; current: string; icon: LucideIcon; label: string; nested?: boolean }) {
  const active = route === current;
  return (
    <a
      className={`snav__item ${nested ? 'snav__item--nested' : ''} ${active ? 'is-active' : ''}`}
      href={`#${route}`}
      aria-current={active ? 'page' : undefined}
      title={label}
    >
      <Icon size={nested ? 15 : 17} aria-hidden="true" />
      <span className="snav__label">{label}</span>
    </a>
  );
}

/** A strategy that is not built yet: visible, never navigable. */
function SoonItem({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="snav__item snav__item--nested is-disabled" aria-disabled="true" title={`${label} — not built yet`}>
      <Icon size={15} aria-hidden="true" />
      <span className="snav__label">{label}</span>
      <span className="snav__soon">Soon</span>
    </span>
  );
}

/**
 * Primary application navigation (permanent left sidebar).
 * Desktop: full sidebar · mid widths: icon rail · small screens: drawer.
 */
export function SideNav({ open, onNavigate }: { open?: boolean; onNavigate?: () => void }) {
  const route = useHashRoute();
  const [expanded, setExpanded] = usePersistentState('tluxe.nav.strategy.open', true, isBool);
  const inStrategy = STRATEGY_NAV.some((s) => s.route === route);

  return (
    <nav
      id="main-nav"
      className={`snav ${open ? 'is-open' : ''}`}
      aria-label="Main navigation"
      onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}
    >
      <a className="snav__brand" href="#/" aria-label={`${BRAND.logoPrimary} ${BRAND.logoSecondary} — dashboard`}>
        <LogoMark size={30} />
        <span className="snav__brand-text">
          <span className="snav__brand-primary">{BRAND.logoPrimary}</span>
          <span className="snav__brand-sep" aria-hidden="true">|</span>
          <span className="snav__brand-secondary">{BRAND.logoSecondary}</span>
        </span>
      </a>

      <div className="snav__list">
        <NavLink route={DASHBOARD_ROUTE} current={route} icon={LayoutDashboard} label="Dashboard" />

        <div className={`snav__group ${inStrategy ? 'has-active' : ''}`}>
          <button
            type="button"
            className="snav__item snav__group-head"
            aria-expanded={expanded}
            aria-controls="snav-strategy"
            onClick={() => setExpanded(!expanded)}
            title="Trading Strategy"
          >
            <LineChart size={17} aria-hidden="true" />
            <span className="snav__label">Trading Strategy</span>
            <ChevronRight size={14} className="snav__chev" aria-hidden="true" />
          </button>
          {expanded && (
            <div className="snav__sub" id="snav-strategy" role="group" aria-label="Trading Strategy">
              {STRATEGY_NAV.map((s) =>
                s.route ? (
                  <NavLink key={s.id} route={s.route} current={route} icon={STRATEGY_ICONS[s.icon]} label={s.label} nested />
                ) : (
                  <SoonItem key={s.id} icon={STRATEGY_ICONS[s.icon]} label={s.label} />
                ),
              )}
            </div>
          )}
        </div>
      </div>

      <div className="snav__foot">
        <NavLink route={SETTINGS_ROUTE} current={route} icon={Settings} label="Settings" />
      </div>
    </nav>
  );
}
