import type { ReactNode } from 'react';
import './ui.css';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  message: ReactNode;
  meta?: ReactNode;
  className?: string;
}

/** Truthful empty state for data that has no provider yet. */
export function EmptyState({ icon, title, message, meta, className }: EmptyStateProps) {
  return (
    <div className={`empty ${className ?? ''}`} role="status">
      <div className="empty__icon" aria-hidden="true">{icon}</div>
      <div className="empty__title">{title}</div>
      <div className="empty__msg">{message}</div>
      {meta && <div className="empty__meta">{meta}</div>}
    </div>
  );
}
