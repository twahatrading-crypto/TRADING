import { useRef } from 'react';

/**
 * Drag handle that resizes a neighbouring workspace pane (presentation only). `dir="col"` = vertical bar (drag
 * left / right), `dir="row"` = horizontal bar (drag up / down). Reports the pixel delta since the drag started;
 * the page clamps and persists the size. Keyboard: arrow keys move by 16 px.
 */
export function OfpSplitter({ dir, label, onDrag, onEnd }: { dir: 'col' | 'row'; label: string; onDrag: (delta: number, start: boolean) => void; onEnd?: () => void }) {
  const start = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      className={`ofp-split ofp-split--${dir}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = dir === 'col' ? e.clientX : e.clientY;
        onDrag(0, true);
      }}
      onPointerMove={(e) => {
        if (start.current === null) return;
        onDrag((dir === 'col' ? e.clientX : e.clientY) - start.current, false);
      }}
      onPointerUp={() => {
        start.current = null;
        onEnd?.();
      }}
      onKeyDown={(e) => {
        const step = e.key === (dir === 'col' ? 'ArrowLeft' : 'ArrowUp') ? -16 : e.key === (dir === 'col' ? 'ArrowRight' : 'ArrowDown') ? 16 : 0;
        if (!step) return;
        e.preventDefault();
        onDrag(0, true);
        onDrag(step, false);
        onEnd?.();
      }}
    />
  );
}
