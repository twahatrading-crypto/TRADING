import { useEffect, useState, type ReactNode } from 'react';
import { MarketBar } from '../market/MarketBar';
import { SideNav } from './SideNav';
import './nav.css';

/**
 * Shared layout for every page: permanent left sidebar + market header + page.
 * It stays mounted across route changes, so navigating never re-creates the
 * header, and never touches providers (those live outside React).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <div className="shell">
      <SideNav open={navOpen} onNavigate={() => setNavOpen(false)} />
      {navOpen && <button type="button" className="shell__scrim" aria-label="Close menu" onClick={() => setNavOpen(false)} />}
      <div className="shell__main">
        <MarketBar onMenu={() => setNavOpen(true)} menuOpen={navOpen} />
        <div className="shell__page">{children}</div>
      </div>
    </div>
  );
}
