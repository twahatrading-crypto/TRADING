import { Globe, Pencil, Plus, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useNow } from '../../store/clock';
import { Panel } from '../ui/Panel';
import { ClockCard } from './ClockCard';
import { useClocks } from './useClocks';
import './clocks.css';

export function WorldClock() {
  const now = useNow('second');
  const { clocks, available, canAdd, add, remove, reset } = useClocks();
  const [editing, setEditing] = useState(false);

  return (
    <Panel
      id="world-clock"
      title="World Clock"
      icon={<Globe size={18} />}
      actions={
        <>
          {editing && (
            <button type="button" className="btn-ghost" onClick={reset} title="Restore default locations">
              <RotateCcw size={13} /> Reset
            </button>
          )}
          <button type="button" className="btn-ghost" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
            <Pencil size={13} /> {editing ? 'Done' : 'Edit'}
          </button>
        </>
      }
    >
      <div className="clocks">
        {clocks.map((c) => (
          <ClockCard key={c.id} clock={c} now={now} editing={editing} onRemove={clocks.length > 1 ? () => remove(c.id) : undefined} />
        ))}
        {editing && canAdd && (
          <label className="clock clock--add">
            <Plus size={16} />
            <span>Add location</span>
            <select
              aria-label="Add location"
              value=""
              onChange={(e) => {
                if (e.target.value) add(e.target.value);
              }}
            >
              <option value="">Select…</option>
              {available.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.city} — {c.timeZone}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </Panel>
  );
}
