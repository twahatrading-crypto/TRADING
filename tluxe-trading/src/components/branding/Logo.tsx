import { BRAND } from '../../config/branding';
import './branding.css';

export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="lm-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f3d690" />
          <stop offset="1" stopColor="#b88a33" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="39" height="39" rx="8" fill="#0d1219" stroke="rgba(212,169,79,.45)" />
      <path d="M7 29 L16 15 L21 22 L26 13 L34 29 Z" fill="url(#lm-g)" />
      <path d="M16 15 L18.6 19 L14.2 19.4 Z M26 13 L28.8 18 L23.8 17.6 Z" fill="#fff6dc" opacity=".85" />
    </svg>
  );
}

export function Logo() {
  return (
    <a className="logo" href="#/" aria-label={`${BRAND.logoPrimary} ${BRAND.logoSecondary} — dashboard`}>
      <LogoMark />
      <span className="logo__text">
        <span className="logo__primary">{BRAND.logoPrimary}</span>
        <span className="logo__sep" aria-hidden="true">|</span>
        <span className="logo__secondary">{BRAND.logoSecondary}</span>
      </span>
    </a>
  );
}
