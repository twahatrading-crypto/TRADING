import { usePersistentState } from '../../hooks/usePersistentState';
import { SRPage } from '../sr/SRPage';
import { SRProPage } from './SRProPage';

type View = 'pro' | 'classic';
const isView = (v: unknown): v is View => v === 'pro' || v === 'classic';

/** S&R route: the Pro view by default; the classic page (replay, engine settings) stays one click away. */
export function SRRoute() {
  const [view, setView] = usePersistentState<View>('tluxe.sr.view', 'pro', isView);
  return (
    <>
      <div className="srp-viewswitch" role="group" aria-label="S&R view">
        <button type="button" aria-pressed={view === 'pro'} onClick={() => setView('pro')}>
          Pro view
        </button>
        <button type="button" aria-pressed={view === 'classic'} onClick={() => setView('classic')}>
          Classic view (replay · engine settings)
        </button>
      </div>
      {view === 'pro' ? <SRProPage /> : <SRPage />}
    </>
  );
}
