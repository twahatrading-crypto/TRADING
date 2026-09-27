/* node --test scripts/scan-bundle.nodetest.cjs (npm run test:scripts) - the build gate for the public (cloud) bundle. TEST DATA ONLY: the "keys" are fake. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, 'scan-bundle.cjs');

function bundle(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tluxe-scan-'));
  fs.mkdirSync(path.join(d, 'assets'));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(d, n), t);
  return d;
}

function scan(d, ...extra) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, d, ...extra], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stderr) };
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

test('passes a clean bundle (env var NAMES in help text are fine)', () => {
  const r = scan(bundle({ 'index.html': '<html></html>', 'assets/a.js': 'const help="set OPENAI_API_KEY on the server";fetch("/api/mt5/v1/health")' }));
  assert.equal(r.code, 0, r.out);
});

for (const [name, code, id] of [
  ['a localhost bridge URL', 'fetch("http://127.0.0.1:8765/v1/health")', 'LOCALHOST_ENDPOINT'],
  ['a localhost name with a port', 'new WebSocket("ws://localhost:8780/api/stream")', 'LOCALHOST_ENDPOINT'],
  ['an OpenAI-shaped key', 'const k="sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234"', 'OPENAI_KEY'],
  ['a Databento-shaped key', 'const k="db-ABCDEFGHIJKLMNOPQRSTUVWXYZ12"', 'DATABENTO_KEY'],
  ['a credential assignment', 'TLUXE_AI_TOKEN="abcdefghijklmnop"', 'CREDENTIAL_ASSIGNMENT'],
  ['a DSN with a password', 'postgresql://tluxe:hunter2hunter2@db.internal:5432/tluxe', 'DSN_WITH_PASSWORD'],
  ['a private key block', '-----BEGIN RSA PRIVATE KEY-----', 'PRIVATE_KEY'],
]) {
  test(`fails on ${name}`, () => {
    const r = scan(bundle({ 'assets/a.js': code }));
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(id));
  });
}

test('the finding never prints a whole secret', () => {
  const key = 'sk-proj-' + 'Q'.repeat(60);
  const r = scan(bundle({ 'assets/a.js': `const k="${key}"` }));
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes(key));
});
