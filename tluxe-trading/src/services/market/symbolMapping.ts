import type { InstrumentDefinition, ProviderFamily, ProviderMapping, ProviderRole } from '../../types/instruments';
import type { Quote } from '../../types/market';

/**
 * Canonical instrument → provider symbol resolution.
 *
 * Nothing here assumes a provider's naming. A symbol is only "resolved" when
 * it is explicitly configured, fixed by the mapping, or found in the list the
 * provider itself reports (discovery). Ambiguity is surfaced, never guessed.
 */

export interface SymbolOverride {
  symbol: string;
  /** Provider quotes the reciprocal pair (e.g. CADUSD for canonical USDCAD). */
  inverted?: boolean;
}

export type SymbolResolution =
  | { status: 'resolved'; providerSymbol: string; inverted: boolean; source: 'override' | 'fixed' | 'discovered' }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not-found' }
  | { status: 'needs-discovery' }
  | { status: 'not-mapped' };

export interface ResolveOptions {
  /** Symbols the provider reports as available. Undefined = discovery has not run. */
  available?: readonly string[];
  /** User/config overrides keyed by canonical instrument id. */
  overrides?: Readonly<Record<string, SymbolOverride>>;
  role?: ProviderRole;
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** Allow short broker suffixes/prefix-free decorations: XAUUSD.a, XAUUSDm, EURUSD.pro … */
const MAX_SUFFIX = 4;

export function findMapping(instrument: InstrumentDefinition, family: ProviderFamily, role: ProviderRole = 'price'): ProviderMapping | undefined {
  return instrument.providerMappings.find((m) => m.family === family && m.role === role);
}

function matchHints(hints: readonly string[], available: readonly string[]): string[] {
  const out = new Set<string>();
  for (const hint of hints.map(norm)) {
    for (const sym of available) {
      const n = norm(sym);
      if (n === hint || (n.startsWith(hint) && n.length - hint.length <= MAX_SUFFIX)) out.add(sym);
    }
  }
  return [...out];
}

export function resolveProviderSymbol(
  instrument: InstrumentDefinition,
  family: ProviderFamily,
  opts: ResolveOptions = {},
): SymbolResolution {
  const mapping = findMapping(instrument, family, opts.role ?? 'price');
  if (!mapping) return { status: 'not-mapped' };
  const { available, overrides } = opts;
  const inList = (s: string) => !available || available.some((a) => norm(a) === norm(s));

  const override = overrides?.[instrument.id];
  if (override) {
    return inList(override.symbol)
      ? { status: 'resolved', providerSymbol: override.symbol, inverted: !!override.inverted, source: 'override' }
      : { status: 'not-found' };
  }

  if (mapping.symbol) {
    return inList(mapping.symbol)
      ? { status: 'resolved', providerSymbol: mapping.symbol, inverted: false, source: 'fixed' }
      : { status: 'not-found' };
  }

  if (!available) return { status: 'needs-discovery' };

  const direct = matchHints(mapping.discoveryHints, available);
  if (direct.length === 1) return { status: 'resolved', providerSymbol: direct[0]!, inverted: false, source: 'discovered' };
  if (direct.length > 1) return { status: 'ambiguous', candidates: direct };

  // FX only: provider may list the reciprocal pair (e.g. CADUSD for USDCAD).
  if (instrument.fx) {
    const reciprocal = matchHints([`${instrument.fx.quote}${instrument.fx.base}`], available);
    if (reciprocal.length === 1) return { status: 'resolved', providerSymbol: reciprocal[0]!, inverted: true, source: 'discovered' };
    if (reciprocal.length > 1) return { status: 'ambiguous', candidates: reciprocal };
  }
  return { status: 'not-found' };
}

const inv = (v: number | null) => (v === null || v === 0 ? null : 1 / v);

/**
 * Convert a reciprocal-pair quote (e.g. CADUSD) into the canonical pair (USDCAD).
 * Bid/ask and high/low swap sides. Change is recomputed from the implied previous
 * price; values that cannot be derived stay null. Volume is unchanged.
 */
export function invertQuote(q: Quote): Quote {
  const last = inv(q.last);
  let change: number | null = null;
  let changePercent: number | null = null;
  if (q.last !== null && q.change !== null && q.last - q.change !== 0 && last !== null) {
    const prev = inv(q.last - q.change);
    if (prev !== null) {
      change = last - prev;
      changePercent = (change / prev) * 100;
    }
  }
  return {
    last,
    change,
    changePercent,
    bid: inv(q.ask),
    ask: inv(q.bid),
    high: inv(q.low),
    low: inv(q.high),
    volume: q.volume,
    timestamp: q.timestamp,
  };
}
