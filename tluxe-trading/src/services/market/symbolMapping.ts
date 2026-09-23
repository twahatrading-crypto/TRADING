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

export type ResolutionTier = 'override' | 'fixed' | 'exact' | 'alias' | 'variant';

export type SymbolResolution =
  | {
      status: 'resolved';
      providerSymbol: string;
      inverted: boolean;
      source: 'override' | 'fixed' | 'discovered';
      /** Which priority tier matched. */
      tier: ResolutionTier;
      /** Other plausible symbols from LOWER tiers (reported, never silently dropped). */
      alternatives: string[];
    }
  | { status: 'ambiguous'; candidates: string[]; tier: ResolutionTier }
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

/**
 * Broker decorations accepted around a base symbol (raw, case-sensitive):
 *  suffix: separator-led (".a", "_i", "-ECN", "+", "#1") or lowercase-only ("m", "pro", "ecn");
 *  prefix: separators / up to 2 lowercase letters ("#", "m.", "c_").
 * An uppercase tail (e.g. "JPY") is NOT a decoration: it could be another instrument.
 */
const SUFFIX_RE = /^(?:[._\-+#!~][A-Za-z0-9]{0,6}|[a-z]{1,4})$/;
const PREFIX_RE = /^(?:[._\-+#!~]{1,2}|[a-z]{1,2}[._\-+#!~]?)$/;
/** Futures contract month code + year, e.g. "Z6", "Z26". Allowed only for futures/depth feeds. */
const MONTH_CODE_RE = /^[._\- ]?[FGHJKMNQUVXZ]\d{1,2}$/;

function isVariant(sym: string, base: string, family: ProviderFamily): boolean {
  const upper = sym.toUpperCase();
  const at = upper.indexOf(base.toUpperCase());
  if (at < 0) return false;
  const prefix = sym.slice(0, at);
  const suffix = sym.slice(at + base.length);
  if (prefix === '' && suffix === '') return false; // that is an exact match, not a variant
  const futures = family === 'futures-feed' || family === 'depth-feed';
  const okPrefix = prefix === '' || PREFIX_RE.test(prefix);
  const okSuffix = suffix === '' || SUFFIX_RE.test(suffix) || (futures && MONTH_CODE_RE.test(suffix));
  return okPrefix && okSuffix;
}

export function findMapping(instrument: InstrumentDefinition, family: ProviderFamily, role: ProviderRole = 'price'): ProviderMapping | undefined {
  return instrument.providerMappings.find((m) => m.family === family && m.role === role);
}

/** Tiered matches for a list of names (first = primary/exact, rest = aliases). */
function tiers(names: readonly string[], available: readonly string[], family: ProviderFamily) {
  const [primary, ...aliases] = names;
  const exact = primary ? available.filter((a) => norm(a) === norm(primary)) : [];
  const alias = available.filter((a) => aliases.some((h) => norm(a) === norm(h)) && !exact.includes(a));
  const variant = available.filter((a) => !exact.includes(a) && !alias.includes(a) && names.some((h) => isVariant(a, h, family)));
  return [
    ['exact', exact],
    ['alias', alias],
    ['variant', variant],
  ] as const;
}

export function resolveProviderSymbol(
  instrument: InstrumentDefinition,
  family: ProviderFamily,
  opts: ResolveOptions = {},
): SymbolResolution {
  const mapping = findMapping(instrument, family, opts.role ?? 'price');
  if (!mapping) return { status: 'not-mapped' };
  const { available, overrides } = opts;
  const inList = (s: string) => !available || available.some((a) => a === s);

  // 1. Explicit user override (must exist on the provider when the list is known).
  const override = overrides?.[instrument.id];
  if (override) {
    return inList(override.symbol)
      ? { status: 'resolved', providerSymbol: override.symbol, inverted: !!override.inverted, source: 'override', tier: 'override', alternatives: [] }
      : { status: 'not-found' };
  }
  // 2. Exact known mapping.
  if (mapping.symbol) {
    return inList(mapping.symbol)
      ? { status: 'resolved', providerSymbol: mapping.symbol, inverted: false, source: 'fixed', tier: 'fixed', alternatives: [] }
      : { status: 'not-found' };
  }
  if (!available) return { status: 'needs-discovery' };

  // 3–4. Discovery: exact canonical/primary name → safe aliases → broker suffix/prefix variants.
  const pick = (names: readonly string[], inverted: boolean): SymbolResolution | null => {
    const t = tiers(names, available, family);
    for (let k = 0; k < t.length; k++) {
      const [tier, matches] = t[k]!;
      if (matches.length > 1) return { status: 'ambiguous', candidates: [...matches], tier };
      if (matches.length === 1) {
        const alternatives = t.slice(k + 1).flatMap(([, m]) => m);
        return { status: 'resolved', providerSymbol: matches[0]!, inverted, source: 'discovered', tier, alternatives };
      }
    }
    return null;
  };
  const hints = mapping.discoveryHints.length ? mapping.discoveryHints : [instrument.id];
  const names = hints.some((h) => norm(h) === norm(instrument.id)) ? hints : [instrument.id, ...hints];
  const direct = pick(names, false);
  if (direct) return direct;

  // 5. FX only: provider may list the reciprocal pair (e.g. CADUSD for USDCAD).
  if (instrument.fx) {
    const recip = pick([`${instrument.fx.quote}${instrument.fx.base}`], true);
    if (recip) return recip;
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
