import type { StatusTone } from '../../types/status';
import './ui.css';

interface StatusPillProps {
  tone: StatusTone | 'info';
  label: string;
  pulse?: boolean;
  compact?: boolean;
  title?: string;
}

export function StatusDot({ tone, pulse }: { tone: StatusPillProps['tone']; pulse?: boolean }) {
  return <span className={`dot dot--${tone} ${pulse ? 'dot--pulse' : ''}`} aria-hidden="true" />;
}

export function StatusPill({ tone, label, pulse, compact, title }: StatusPillProps) {
  return (
    <span className={`pill pill--${tone} ${compact ? 'pill--compact' : ''}`} title={title}>
      <StatusDot tone={tone} pulse={pulse} />
      {label}
    </span>
  );
}
