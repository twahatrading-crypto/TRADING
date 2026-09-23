import { AiPanel } from '../ai/AiPanel';
import { BrandHero } from '../branding/BrandHero';
import { CalendarPanel } from '../calendar/CalendarPanel';
import { ChartPanel } from '../chart/ChartPanel';
import { WorldClock } from '../clocks/WorldClock';
import { MarketBar } from '../market/MarketBar';
import { NewsPanel } from '../news/NewsPanel';
import { SessionsPanel } from '../sessions/SessionsPanel';
import { SystemStatusPanel } from '../status/SystemStatusPanel';
import { Footer } from './Footer';
import { MobileNav } from './MobileNav';
import { ModuleCards } from './ModuleCards';
import './dashboard.css';

/**
 * Layout: three column wrappers on desktop. On tablet/mobile the wrappers
 * become `display: contents` so every panel joins one grid and is re-ordered
 * with grid areas — the markup never changes between breakpoints.
 */
export function Dashboard() {
  return (
    <div className="app">
      <MarketBar />
      <BrandHero />
      <main className="dash">
        <div className="dash__col dash__col--main">
          <div className="area-clocks"><WorldClock /></div>
          <div className="area-sessions"><SessionsPanel /></div>
          <div className="area-chart"><ChartPanel /></div>
          <div className="area-modules"><ModuleCards /></div>
        </div>
        <div className="dash__col dash__col--side">
          <div className="area-calendar"><CalendarPanel /></div>
          <div className="area-news"><NewsPanel /></div>
          <div className="area-status"><SystemStatusPanel /></div>
        </div>
        <div className="dash__col dash__col--ai">
          <div className="area-ai"><AiPanel /></div>
        </div>
      </main>
      <Footer />
      <MobileNav />
    </div>
  );
}
