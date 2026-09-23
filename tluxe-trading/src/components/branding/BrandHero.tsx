import { BRAND } from '../../config/branding';
import { useNow } from '../../store/clock';
import { greetingFor } from '../../utils/greeting';
import { getZonedParts, getBrowserTimeZone } from '../../utils/time';
import './branding.css';

function Greeting() {
  const now = useNow('minute');
  return <>{greetingFor(getZonedParts(now, getBrowserTimeZone()).hour)}, Trader</>;
}

/**
 * Compact brand banner. The artwork is one inline SVG drawn for a wide,
 * short band (1600×100) so the ridge and sunrise stay in frame at every width.
 */
export function BrandHero() {
  return (
    <section className="hero" aria-label="Trading by TLUXE">
      <svg className="hero__art" viewBox="0 0 1600 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <radialGradient id="hero-sun" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ffd98a" stopOpacity=".9" />
            <stop offset=".2" stopColor="#e7a543" stopOpacity=".5" />
            <stop offset=".6" stopColor="#7a4d17" stopOpacity=".14" />
            <stop offset="1" stopColor="#000" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="hero-far" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5c6370" />
            <stop offset="1" stopColor="#161b23" />
          </linearGradient>
          <linearGradient id="hero-near" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#262c37" />
            <stop offset="1" stopColor="#0a0d12" />
          </linearGradient>
          <linearGradient id="hero-fade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#06080c" stopOpacity=".96" />
            <stop offset=".34" stopColor="#06080c" stopOpacity=".25" />
            <stop offset=".78" stopColor="#06080c" stopOpacity=".1" />
            <stop offset="1" stopColor="#06080c" stopOpacity=".9" />
          </linearGradient>
        </defs>
        <ellipse cx="930" cy="46" rx="520" ry="70" fill="url(#hero-sun)" />
        <circle className="hero__sun" cx="930" cy="40" r="9" fill="#ffe3a3" opacity=".92" />
        <circle className="hero__sun" cx="930" cy="40" r="20" fill="#ffcf70" opacity=".2" />
        {/* Ridge paths authored on a 1200×200 grid, mapped into the 1600×100 band. */}
        <g transform="matrix(1.3334 0 0 0.5 0 -2)">
          <path
            fill="url(#hero-far)"
            d="M0 200 L0 150 L90 118 L170 132 L260 86 L330 110 L420 62 L480 90 L540 48 L600 96 L640 70 L700 104 L760 40 L830 92 L900 66 L960 102 L1040 74 L1120 110 L1200 92 L1200 200 Z"
          />
          <path
            fill="#e9dcc0"
            opacity=".45"
            d="M420 62 L436 74 L426 76 Z M540 48 L560 64 L546 66 Z M760 40 L784 60 L766 62 Z M900 66 L916 78 L904 80 Z"
          />
          <path
            fill="url(#hero-near)"
            d="M0 200 L0 170 L120 140 L210 158 L320 120 L420 150 L520 116 L610 146 L700 128 L790 150 L880 118 L990 150 L1080 132 L1200 150 L1200 200 Z"
          />
        </g>
        <rect width="1600" height="100" fill="url(#hero-fade)" />
      </svg>

      <div className="hero__content">
        <div className="hero__left">
          <h1 className="hero__title">
            Trading by <span className="hero__gold">TLUXE</span>
          </h1>
          <div className="hero__sub">
            <span className="hero__greeting"><Greeting /></span>
            <p className="hero__tagline">
              {BRAND.tagline.map((t, i) => (
                <span key={t}>
                  {i > 0 && <span className="hero__bullet" aria-hidden="true">•</span>}
                  {t}
                </span>
              ))}
            </p>
          </div>
        </div>
        <figure className="hero__quote">
          <blockquote>“{BRAND.quote}”</blockquote>
          <figcaption>— {BRAND.quoteAuthor}</figcaption>
        </figure>
      </div>
    </section>
  );
}
