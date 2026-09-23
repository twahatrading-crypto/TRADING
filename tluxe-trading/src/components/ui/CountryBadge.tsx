import './ui.css';

/** Text badge for a country/region code — avoids emoji flags, which render inconsistently. */
export function CountryBadge({ code }: { code: string }) {
  return <span className="cbadge" aria-label={code}>{code}</span>;
}
