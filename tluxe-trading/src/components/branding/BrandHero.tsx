import { BRAND } from '../../config/branding';
import { useNow } from '../../store/clock';
import { greetingFor } from '../../utils/greeting';
import { getZonedParts, getBrowserTimeZone } from '../../utils/time';
import './branding.css';

function Greeting() {
  const now = useNow('minute');
  return <>{greetingFor(getZonedParts(now, getBrowserTimeZone()).hour)}, Trader</>;
}

/** Brand header. Mountains are a single inline SVG — no image requests. */
export function BrandHero() {
  return (
    <section className="hero" aria-label="Trading by TLUXE">
      <svg className="hero__art" viewBox="0 0 1600 160" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <defs>
          <radialGradient id="hero-sun" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ffd98a" stopOpacity=".95" />
            <stop offset=".18" stopColor="#e7a543" stopOpacity=".55" />
            <stop offset=".55" stopColor="#7a4d17" stopOpacity=".16" />
            <stop offset="1" stopColor="#000" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="hero-far" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#59606d" />
            <stop offset="1" stopColor="#1a1f28" />
          </linearGradient>
          <linearGradient id="hero-near" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2a303b" />
            <stop offset="1" stopColor="#0b0f15" />
          </linearGradient>
          <linearGradient id="hero-fade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#06080c" stopOpacity=".92" />
            <stop offset=".3" stopColor="#06080c" stopOpacity=".05" />
            <stop offset=".82" stopColor="#06080c" stopOpacity=".05" />
            <stop offset="1" stopColor="#06080c" stopOpacity=".95" />
          </linearGradient>
        </defs>
        <ellipse cx="930" cy="80" rx="560" ry="120" fill="url(#hero-sun)" />
        <circle className="hero__sun" cx="930" cy="66" r="13" fill="#ffe3a3" opacity=".9" />
        <circle className="hero__sun" cx="930" cy="66" r="30" fill="#ffcf70" opacity=".2" />
        <g transform="matrix(1.3334 0 0 0.75 0 10)">
        <path
          fill="url(#hero-far)"
          d="M0 200 L0 150 L90 118 L170 132 L260 86 L330 110 L420 62 L480 90 L540 48 L600 96 L640 70 L700 104 L760 40 L830 92 L900 66 L960 102 L1040 74 L1120 110 L1200 92 L1200 200 Z"
        />
        <path
          fill="#e9dcc0"
          opacity=".5"
          d="M420 62 L436 74 L426 76 Z M540 48 L560 64 L546 66 Z M760 40 L784 60 L766 62 Z M900 66 L916 78 L904 80 Z"
        />
        <path
          fill="url(#hero-near)"
          d="M0 200 L0 170 L120 140 L210 158 L320 120 L420 150 L520 116 L610 146 L700 128 L790 150 L880 118 L990 150 L1080 132 L1200 150 L1200 200 Z"
        />
        </g>
        <rect width="1600" height="160" fill="url(#hero-fade)" />
      </svg>

      <div className="hero__content">
        <div className="hero__left">
          <div className="hero__greeting"><Greeting /></div>
          <h1 className="hero__title">
            Trading by <span className="hero__gold">TLUXE</span>
          </h1>
          <p className="hero__tagline">
            {BRAND.tagline.map((t, i) => (
              <span key={t}>
                {i > 0 && <span className="hero__bullet" aria-hidden="true">•</span>}
                {t}
              </span>
            ))}
          </p>
        </div>
        <figure className="hero__quote">
          <blockquote>“{BRAND.quote}”</blockquote>
          <figcaption>— {BRAND.quoteAuthor}</figcaption>
        </figure>
      </div>
    </section>
  );
}
