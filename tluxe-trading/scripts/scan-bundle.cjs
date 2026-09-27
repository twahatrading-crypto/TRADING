#!/usr/bin/env node
/*
 * Scans a built bundle (default dist-cloud) and FAILS if it contains anything a public web bundle must never carry:
 *   - a loopback / localhost endpoint with a port (the cloud app must not depend on the owner's PC)
 *   - anything shaped like an OpenAI (sk-...) or Databento (db-...) API key, or a private key block
 *   - an assignment of a credential env var (OPENAI_API_KEY=..., DATABENTO_API_KEY=..., TE_API_KEY=..., *_TOKEN=...)
 *   - any VALUE found in the local, git-ignored bridge/gateway .env files (so a real key can never be inlined)
 * Usage: node scripts/scan-bundle.cjs [dir] [--allow-localhost]
 * Env var NAMES may appear (help text); values may not. The .env values are never printed.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const dir = path.resolve(root, args.find((a) => !a.startsWith('--')) || 'dist-cloud');
const allowLocalhost = args.includes('--allow-localhost');

if (!fs.existsSync(dir)) {
  console.error(`scan-bundle: ${path.relative(root, dir)} does not exist - build it first.`);
  process.exit(2);
}

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|css|html|json|map|txt|svg|webmanifest)$/i.test(e.name)) files.push(p);
  }
})(dir);

const RULES = [
  ...(allowLocalhost ? [] : [{ id: 'LOCALHOST_ENDPOINT', re: /\b(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):\d{2,5}\b/g }]),
  { id: 'OPENAI_KEY', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'DATABENTO_KEY', re: /\bdb-[A-Za-z0-9]{20,}/g },
  { id: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'CREDENTIAL_ASSIGNMENT', re: /\b(?:OPENAI_API_KEY|DATABENTO_API_KEY|TE_API_KEY|TRADING_ECONOMICS_API_KEY|TLUXE_[A-Z_]*TOKEN|TLUXE_OWNER_PASSWORD_HASH|DATABASE_URL)\s*[:=]\s*["'`]?[A-Za-z0-9_\-:$./+]{8,}/g },
  { id: 'DSN_WITH_PASSWORD', re: /\bpostgres(?:ql)?:\/\/[^\s:@/"'`]+:[^\s@/"'`]+@/g },
];

// Real local secret values (never printed): every value in git-ignored .env files next to the bridges / gateway.
const secretValues = [];
for (const rel of ['bridge/mt5/.env', 'bridge/databento/.env', 'bridge/ai/.env', 'bridge/news/.env', 'bridge/mt5/remote_link/.env', 'cloud/gateway/.env', '.env']) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (/(KEY|TOKEN|SECRET|PASSWORD|HASH|DATABASE_URL)/.test(m[1]) && v.length >= 12) secretValues.push({ name: m[1], value: v });
  }
}

const findings = [];
let bytes = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  bytes += text.length;
  const rel = path.relative(root, f);
  for (const r of RULES) {
    for (const m of text.matchAll(r.re)) findings.push(`${r.id} in ${rel}: ${m[0].slice(0, 40)}`);
  }
  for (const s of secretValues) if (text.includes(s.value)) findings.push(`LOCAL_SECRET_VALUE (${s.name}) in ${rel}`);
}

if (findings.length) {
  console.error(`scan-bundle: FAILED - ${findings.length} finding(s) in ${path.relative(root, dir)}:`);
  for (const f of findings.slice(0, 50)) console.error('  ' + f);
  process.exit(1);
}
console.log(
  `scan-bundle: OK - ${files.length} files (${(bytes / 1024).toFixed(0)} KiB) in ${path.relative(root, dir)}: no localhost endpoint${allowLocalhost ? ' check (skipped)' : ''}, no API key, no credential, ` +
    `none of ${secretValues.length} local .env secret value(s).`,
);
