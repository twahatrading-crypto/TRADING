import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useServices } from '../../app/servicesContext';
import { groupInstruments, searchInstruments } from '../../config/instruments';
import { useActiveInstrument } from '../../hooks/useMarket';
import { useStore } from '../../store/createStore';
import { ASSET_CLASS_LABEL, type InstrumentDefinition } from '../../types/instruments';
import './selector.css';

/** Compact source label: listing exchange, MT5 broker, or provider-dependent. */
function venueShort(i: InstrumentDefinition): string {
  if (i.exchange) return i.exchange;
  const families = new Set(i.providerMappings.filter((m) => m.role === 'price').map((m) => m.family));
  return families.size === 1 && families.has('mt5') ? 'MT5' : 'Provider';
}

/** Per-instrument price-feed indicator, read from that instrument's own state. */
function FeedDot({ id }: { id: string }) {
  const { market } = useServices();
  const connection = useStore(market.store(id), (s) => s.connection);
  const live = connection === 'LIVE' || connection === 'DELAYED';
  const label = live ? 'Price feed connected' : 'Price feed not connected';
  return <span className={`sym__dot ${live ? 'is-live' : ''}`} title={label} aria-label={label} role="img" />;
}

export function SymbolSelector() {
  const { instruments } = useServices();
  const active = useActiveInstrument();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const all = instruments.list;
  const groups = useMemo(() => groupInstruments(searchInstruments(query, all)), [query, all]);
  const flat = useMemo(() => groups.flatMap((g) => g.instruments), [groups]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const choose = (i: InstrumentDefinition) => {
    instruments.select(i.id);
    close();
  };

  useEffect(() => {
    if (!open) return;
    setCursor(Math.max(0, flat.findIndex((i) => i.id === active.id)));
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset cursor only when opening
  }, [open]);

  // Global shortcut: Ctrl/⌘ + K opens the selector.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    document.getElementById(`${listId}-opt-${cursor}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor, listId]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(flat.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = flat[cursor];
      if (pick) choose(pick);
    } else if (e.key === 'Escape') {
      close();
    }
  };

  let index = -1;
  return (
    <div className="sym" ref={rootRef}>
      <button
        type="button"
        className="sym__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Instrument: ${active.displayName}. Change instrument`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="sym__row">
          <span className="sym__id">{active.shortName}</span>
          <span className="sym__name">{active.name}</span>
          <ChevronDown size={15} className="sym__chev" aria-hidden="true" />
        </span>
        <span className="sym__meta">
          {ASSET_CLASS_LABEL[active.assetClass]} · {active.exchange ?? venueShort(active)} · {active.currency}
        </span>
      </button>

      {open && (
        <div className="sym__pop" role="dialog" aria-label="Select instrument">
          <div className="sym__search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={flat[cursor] ? `${listId}-opt-${cursor}` : undefined}
              aria-label="Search instruments"
              placeholder="Search symbol or name…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={onKeyDown}
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="sym__kbd">Esc</kbd>
          </div>
          <div className="sym__list" id={listId} role="listbox" aria-label="Instruments">
            {groups.length === 0 && <div className="sym__none">No instruments match “{query}”.</div>}
            {groups.map((g) => (
              <div key={g.assetClass} role="group" aria-label={ASSET_CLASS_LABEL[g.assetClass]}>
                <div className="sym__group">{ASSET_CLASS_LABEL[g.assetClass]}</div>
                {g.instruments.map((i) => {
                  index += 1;
                  const n = index;
                  const selected = i.id === active.id;
                  return (
                    <div
                      key={i.id}
                      id={`${listId}-opt-${n}`}
                      role="option"
                      aria-selected={selected}
                      className={`sym__opt ${n === cursor ? 'is-cursor' : ''} ${selected ? 'is-selected' : ''}`}
                      onMouseEnter={() => setCursor(n)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(i)}
                      data-testid={`symbol-option-${i.id}`}
                    >
                      <span className="sym__opt-id">{i.shortName}</span>
                      <span className="sym__opt-name">
                        {i.name}
                        {!i.tradable && <em className="sym__opt-note"> · category</em>}
                      </span>
                      <span className="sym__opt-venue">
                        {ASSET_CLASS_LABEL[i.assetClass]} · {venueShort(i)}
                      </span>
                      <FeedDot id={i.id} />
                      <span className="sym__opt-check" aria-hidden="true">{selected && <Check size={14} />}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="sym__foot">
            <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span><kbd>Enter</kbd> select</span>
            <span><kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>K</kbd> open</span>
          </div>
        </div>
      )}
    </div>
  );
}
