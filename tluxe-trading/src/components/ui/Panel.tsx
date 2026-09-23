import type { ReactNode } from 'react';
import './ui.css';

interface PanelProps {
  id?: string;
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  subtitle?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function Panel({ id, title, icon, actions, subtitle, className, bodyClassName, children }: PanelProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} className={`panel ${className ?? ''}`} aria-labelledby={headingId}>
      <header className="panel__head">
        <div className="panel__title-wrap">
          {icon && <span className="panel__icon" aria-hidden="true">{icon}</span>}
          <div className="panel__titles">
            <h2 className="panel__title" id={headingId}>{title}</h2>
            {subtitle && <div className="panel__subtitle">{subtitle}</div>}
          </div>
        </div>
        {actions && <div className="panel__actions">{actions}</div>}
      </header>
      <div className={`panel__body ${bodyClassName ?? ''}`}>{children}</div>
    </section>
  );
}
