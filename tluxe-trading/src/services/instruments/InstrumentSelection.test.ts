import { describe, expect, it } from 'vitest';
import { INSTRUMENTS } from '../../config/instruments';
import { memoryStorage } from '../../test/providers';
import { InstrumentSelection, SELECTED_INSTRUMENT_KEY } from './InstrumentSelection';

describe('InstrumentSelection', () => {
  it('defaults to GC', () => {
    expect(new InstrumentSelection(INSTRUMENTS, memoryStorage()).active.id).toBe('GC');
  });

  it('persists the selection and restores it in a new session', () => {
    const storage = memoryStorage();
    const a = new InstrumentSelection(INSTRUMENTS, storage);
    a.select('XAGUSD');
    expect(storage.data.get(SELECTED_INSTRUMENT_KEY)).toBe('XAGUSD');
    expect(new InstrumentSelection(INSTRUMENTS, storage).active.id).toBe('XAGUSD');
  });

  it('ignores an unknown stored id (e.g. CADUSD) and falls back to the default', () => {
    expect(new InstrumentSelection(INSTRUMENTS, memoryStorage({ [SELECTED_INSTRUMENT_KEY]: 'CADUSD' })).active.id).toBe('GC');
  });

  it('rejects unknown ids', () => {
    expect(() => new InstrumentSelection(INSTRUMENTS, memoryStorage()).select('NQ')).toThrow();
  });

  it('keeps working when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const s = new InstrumentSelection(INSTRUMENTS, broken);
    s.select('BTCUSD');
    expect(s.active.id).toBe('BTCUSD');
  });

  it('notifies subscribers on change only', () => {
    const s = new InstrumentSelection(INSTRUMENTS, memoryStorage());
    let n = 0;
    s.store.subscribe(() => n++);
    s.select('GC');
    s.select('SI');
    expect(n).toBe(1);
  });
});
