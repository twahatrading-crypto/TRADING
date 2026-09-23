import { Activity, BrainCircuit, ChartCandlestick, Globe, HeartPulse } from 'lucide-react';
import './dashboard.css';

const LINKS = [
  { href: '#sessions', label: 'Sessions', icon: Activity },
  { href: '#chart', label: 'Chart', icon: ChartCandlestick },
  { href: '#ai', label: 'AI', icon: BrainCircuit },
  { href: '#world-clock', label: 'Clocks', icon: Globe },
  { href: '#status', label: 'Status', icon: HeartPulse },
];

/** Bottom section switcher shown only on phones. Uses in-page anchors, not routes. */
export function MobileNav() {
  const jump = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault();
    document.querySelector(href)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <nav className="mnav" aria-label="Jump to section">
      {LINKS.map(({ href, label, icon: Icon }) => (
        <a key={href} href={href} onClick={(e) => jump(e, href)}>
          <Icon size={18} />
          <span>{label}</span>
        </a>
      ))}
    </nav>
  );
}
