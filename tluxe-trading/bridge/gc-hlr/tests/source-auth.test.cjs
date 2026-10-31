/* GC HLR -> gateway credential. Needs none of the HLR originals, so it runs anywhere (CI included):
       node --test bridge/gc-hlr/tests/source-auth.test.cjs
   TEST DATA ONLY: throw-away tokens; a stand-in gateway on loopback. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { sourceAuth, sourceHeaders } = require('../lib/source-auth.cjs');

const TOKEN = 'gc-hlr-unit-test-token-' + 'u'.repeat(30);
const SERVER = path.join(__dirname, '..', 'server.cjs');

test('no token: runs without a header and says why it will be refused once login is on', () => {
  const a = sourceAuth({}, 'https://twahatrading.com');
  assert.strictEqual(a.problem, null);
  assert.match(a.warning, /GC_HLR_SOURCE_TOKEN is not set/);
  assert.deepStrictEqual(sourceHeaders(a, 'UA'), { 'User-Agent': 'UA' });
});

test('a valid token goes only into the Authorization header', () => {
  const a = sourceAuth({ GC_HLR_SOURCE_TOKEN: `  ${TOKEN}  ` }, 'https://twahatrading.com');
  assert.strictEqual(a.problem, null);
  assert.deepStrictEqual(sourceHeaders(a, 'UA'), { 'User-Agent': 'UA', Authorization: `Bearer ${TOKEN}` });
  assert.ok(sourceAuth({ GC_HLR_SOURCE_TOKEN: TOKEN }, 'http://127.0.0.1:8099').token);  // loopback test gateway
});

test('fails closed: weak token, clear-text or decorated source; messages never contain the token', () => {
  const bad = [
    [{ GC_HLR_SOURCE_TOKEN: 'short' }, 'https://twahatrading.com'],
    [{ GC_HLR_SOURCE_TOKEN: TOKEN.slice(0, 20) + ' ' + TOKEN.slice(20) }, 'https://twahatrading.com'],
    [{ GC_HLR_SOURCE_TOKEN: TOKEN }, 'http://twahatrading.com'],
    [{ GC_HLR_SOURCE_TOKEN: TOKEN }, 'http://192.168.1.5:8080'],
    [{ GC_HLR_SOURCE_TOKEN: TOKEN }, 'https://user:pw@twahatrading.com'],
    [{ GC_HLR_SOURCE_TOKEN: TOKEN }, 'https://twahatrading.com/?x=1'],
    [{ GC_HLR_SOURCE_TOKEN: TOKEN }, 'not a url'],
  ];
  for (const [env, src] of bad) {
    const a = sourceAuth(env, src);
    assert.ok(a.problem, src);
    assert.strictEqual(a.token, '');
    assert.ok(!a.problem.includes(TOKEN.slice(0, 20)));
    assert.deepStrictEqual(sourceHeaders(a, 'UA'), { 'User-Agent': 'UA' });
  }
});

test('the service refuses to start with a token and a clear-text source (before reading anything)', () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: { ...process.env, GC_HLR_SOURCE: 'http://twahatrading.com', GC_HLR_SOURCE_TOKEN: TOKEN, GC_HLR_ORIGINALS: '/nonexistent' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /refusing to start: GC_HLR_SOURCE must be https/);
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
});

test('the service sends the credential on every candle request and only to the GC candle path', async () => {
  // Stand-in gateway; the HLR originals are replaced by empty stand-ins, so analysis is withheld - the point
  // here is only what the producer SENDS. It never generates data either way.
  const fs = require('node:fs');
  const os = require('node:os');
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'gchlr-'));
  for (const f of ['data.js', 'vpr-engine.js', 'hlr-engine.js']) fs.writeFileSync(path.join(stub, f), '');
  const seen = [];
  const gw = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || '' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"bars":[]}');
  });
  await new Promise((ok) => gw.listen(0, '127.0.0.1', ok));
  const port = gw.address().port;
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, GC_HLR_SOURCE: `http://127.0.0.1:${port}`, GC_HLR_SOURCE_TOKEN: TOKEN,
           GC_HLR_ORIGINALS: stub, GC_HLR_PORT: '0', GC_HLR_POLL_MS: '60000' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 8000;
  while (seen.length < 5 && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 100));
  child.kill();
  gw.close();
  fs.rmSync(stub, { recursive: true, force: true });
  assert.ok(seen.length >= 5, `expected the five timeframes, saw ${seen.length}`);
  for (const s of seen) {
    assert.strictEqual(s.url.split('?')[0], '/api/databento/v1/candles/GC');
    assert.strictEqual(s.auth, `Bearer ${TOKEN}`);
    assert.ok(!s.url.includes(TOKEN));
  }
  assert.ok(!out.includes(TOKEN), 'the token must never be printed');
});
