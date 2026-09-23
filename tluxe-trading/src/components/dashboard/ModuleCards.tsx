import { MODULES } from '../../config/modules';
import { MODULE_ICONS } from './moduleIcons';
import './dashboard.css';

export function ModuleCards() {
  return (
    <nav className="modules" aria-label="Dashboard modules">
      {MODULES.map((m) => {
        const Icon = MODULE_ICONS[m.icon];
        return (
          <a key={m.id} className="module" href={`#${m.path}`}>
            <span className="module__icon" aria-hidden="true"><Icon size={22} /></span>
            <span className="module__title">{m.title}</span>
            <span className="module__desc">{m.description}</span>
          </a>
        );
      })}
    </nav>
  );
}
