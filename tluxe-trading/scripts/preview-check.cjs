/*
 * Live-preview health check for the running dev server (npm run dev, port 5181).
 *   node scripts/preview-check.cjs            → render + console check on every page
 *   node scripts/preview-check.cjs --hmr      → also edits a component, verifies HMR
 *                                               (no full reload, state kept, no duplicate polling)
 * Uses the pre-installed Playwright (global). Never injects market data: the MT5
 * provider is only enabled against an unreachable bridge to count polling requests.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(execSync('npm root -g').toString().trim() + '/playwright'));
}

const BASE = process.env.PREVIEW_URL || 'http://localhost:5181';
const PAGES = ['/#/', '/#/engines/support-resistance', '/#/settings'];
const HMR = process.argv.includes('--hmr');
const HMR_FILE = path.join(__dirname, '../src/components/market/MarketBar.tsx');
const BRIDGE = 'http://127.0.0.1:8765';

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((bridge) => {
    if (!sessionStorage.getItem('pc.init')) {
      sessionStorage.setItem('pc.init', '1');
      localStorage.setItem('tluxe.mt5.config.v1', JSON.stringify({ enabled: true, bridgeUrl: bridge, token: 'x'.repeat(40), healthMs: 1000 }));
      localStorage.setItem('tluxe.instrument.v1', 'XAUUSD');
    }
  }, BRIDGE);
  const p = await ctx.newPage();
  const problems = [];
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('ERR_CONNECTION_REFUSED') && !m.text().includes('Failed to load resource')) problems.push(`console: ${m.text()}`);
  });
  const hits = [];
  p.on('request', (r) => r.url().startsWith(BRIDGE) && hits.push({ t: Date.now(), path: new URL(r.url()).pathname }));
  const healthRate = async (ms) => {
    const start = Date.now();
    await p.waitForTimeout(ms);
    return hits.filter((h) => h.t >= start && h.path === '/v1/health').length / (ms / 1000);
  };

  for (const route of PAGES) {
    await p.goto(BASE + route, { waitUntil: 'networkidle' });
    await p.waitForTimeout(800);
    const ok = await p.evaluate(() => !!document.querySelector('.mbar') && document.body.innerText.length > 100);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`${ok ? 'OK  ' : 'FAIL'} render ${route}  overflow=${overflow}px`);
    if (!ok) problems.push(`render failed: ${route}`);
  }
  const rate = await healthRate(5000);
  console.log(`bridge health polls/s: ${rate.toFixed(1)} (expected ≈1 — one loop)`);
  if (rate > 1.5) problems.push(`duplicate polling: ${rate}/s`);

  if (HMR) {
    await p.evaluate(() => ((window).__pcMarker = 'alive'));
    const before = await p.evaluate(() => localStorage.getItem('tluxe.instrument.v1'));
    const src = fs.readFileSync(HMR_FILE, 'utf8');
    try {
      fs.writeFileSync(HMR_FILE, src + '\n// preview-check HMR probe\n');
      await p.waitForTimeout(2500);
      const marker = await p.evaluate(() => (window).__pcMarker);
      const after = await p.evaluate(() => localStorage.getItem('tluxe.instrument.v1'));
      const rateAfter = await healthRate(5000);
      console.log(`HMR: ${marker === 'alive' ? 'hot update (no full reload)' : 'FULL RELOAD'} · instrument ${before}→${after} · polls/s ${rateAfter.toFixed(1)}`);
      if (marker !== 'alive') problems.push('component edit caused a full reload');
      if (after !== before) problems.push('instrument selection reset');
      if (rateAfter > 1.5) problems.push(`duplicate polling after HMR: ${rateAfter}/s`);
    } finally {
      fs.writeFileSync(HMR_FILE, src);
      await p.waitForTimeout(1500);
    }
    const stillOk = await p.evaluate(() => !!document.querySelector('.mbar'));
    if (!stillOk) problems.push('page broken after HMR revert');
  }

  await b.close();
  if (problems.length) {
    console.log('PROBLEMS:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log('Preview healthy.');
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
