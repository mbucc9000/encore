'use strict';
// adminauth.js (1.1.0): ADMIN_ALLOW, proxy-header refusal, the per-address failure limit, first-run password setup,
// /v1/pair only from allowed addresses, and how http.js wires them (plus the Engine sign-in card's route and the
// log lines that must never carry a name). Offline: fake requests and a local server with stubs, no engine, no Spotify.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { AdminAuth, parseAllow, normIp, isPrivate, forwardedClient, MAX_FAILURES, LOCK_MS } = require('../src/adminauth');
const { createServer } = require('../src/http');
const { Auth } = require('../src/auth');
const { Diag } = require('../src/diag');

const FAST = { N: 1024 };                                       // scrypt: quick in tests (the real default is 16384)
const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-adminauth-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });
const basic = (pw, user = 'admin') => 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');

// console capture: the bridge's log lines (log.js writes through console.log / console.warn / console.error)
function capture() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => Object.assign(console, orig) };
}

test('allow list: the private default, custom lists, IPv4-mapped and zoned addresses, bad entries', () => {
  for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '100.64.0.1', '100.127.255.255',
    'fd12:3456::1', 'fc00::5', 'fe80::1', 'febf::1', '::ffff:192.168.1.5', 'fe80::1%eth0', '[::1]']) assert.equal(isPrivate(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.255.255', '100.128.0.1', '100.63.255.255', '11.0.0.1', '2001:db8::1', '::ffff:8.8.8.8',
    '', null, undefined, 'garbage', '192.168.1', '1.2.3.4.5']) assert.equal(isPrivate(ip), false, String(ip));
  assert.equal(normIp('::FFFF:10.0.0.9'), '10.0.0.9');
  assert.equal(normIp('[2001:db8::1]'), '2001:db8::1');

  let a = new AdminAuth({ cfg: { adminAllow: 'private, 203.0.113.7' } });
  assert.equal(a.allowed('203.0.113.7'), true);
  assert.equal(a.allowed('203.0.113.8'), false);
  assert.equal(a.allowed('192.168.0.9'), true);

  a = new AdminAuth({ cfg: { adminAllow: '192.168.5.0/24;2001:db8:1::/48' } });
  assert.equal(a.allowed('192.168.5.77'), true);
  assert.equal(a.allowed('192.168.6.1'), false, 'a custom list replaces the private default');
  assert.equal(a.allowed('10.0.0.1'), false);
  assert.equal(a.allowed('2001:db8:1:ffff::1'), true);
  assert.equal(a.allowed('2001:db8:2::1'), false);
  assert.equal(a.allowed('127.0.0.1'), true, 'this computer is always allowed');
  assert.equal(a.allowed('::1'), true);

  const p = parseAllow('foo, 10.0.0.0/33, 1.2.3.4/x, 1.2.3.4/8/9, 300.1.1.1');
  assert.deepEqual(p.entries, []);
  assert.equal(p.bad.length, 5);
  const cap = capture();
  try {
    a = new AdminAuth({ cfg: { adminAllow: 'foo, 10.0.0.0/33', adminPassword: 'x' } });
    a.announce(8095);
  } finally { cap.restore(); }
  assert.equal(a.allowed('10.0.0.1'), false, 'nothing usable: never "everyone", never the private default');
  assert.equal(a.allowed('8.8.8.8'), false);
  assert.equal(a.allowed('127.0.0.1'), true, 'this computer only');
  assert.ok(cap.lines.some((l) => /ADMIN_ALLOW: ignored 2 entries/.test(l)) && cap.lines.some((l) => /no usable entry/.test(l)), cap.lines.join('\n'));
  assert.ok(!cap.lines.some((l) => l.includes('foo')), 'the bad entries themselves are not logged');
});

test('gate: proxy headers are refused unless ADMIN_TRUST_PROXY; then both hops must be allowed', () => {
  const a = new AdminAuth({ cfg: {} });
  assert.equal(a.gate(req('192.168.1.10')), null);
  assert.equal(a.gate(req('::ffff:10.0.0.2')), null);
  let r = a.gate(req('8.8.8.8'));
  assert.equal(r.status, 403); assert.equal(r.code, 'forbidden');
  for (const h of [{ 'x-forwarded-for': '192.168.1.10' }, { forwarded: 'for=192.168.1.10' }, { 'x-real-ip': '10.0.0.1' }]) {
    r = a.gate(req('127.0.0.1', h));
    assert.equal(r.status, 403, JSON.stringify(h)); assert.equal(r.code, 'proxied');
  }
  assert.equal(a.info().proxied, 3);

  const t = new AdminAuth({ cfg: { adminTrustProxy: true } });
  assert.equal(t.gate(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9, 192.168.1.10' })), null, 'the last hop is the client the proxy saw');
  assert.equal(t.gate(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.10, 203.0.113.9' })).code, 'forbidden', 'an internet client behind the proxy');
  assert.equal(t.gate(req('8.8.8.8', { 'x-forwarded-for': '192.168.1.10' })).code, 'forbidden', 'the proxy itself must be allowed');
  assert.equal(t.gate(req('127.0.0.1', { forwarded: 'for=192.0.2.60;proto=http, for="[fd00::7]:4711"' })), null);
  assert.equal(t.gate(req('127.0.0.1', { forwarded: 'for="[2001:db8::1]:4711"' })).code, 'forbidden');
  assert.equal(t.gate(req('127.0.0.1', { forwarded: 'proto=http' })).code, 'forbidden', 'a proxy header without a client');
  assert.equal(forwardedClient({ forwarded: 'for=192.0.2.43:4711' }), '192.0.2.43');
  assert.equal(forwardedClient({ 'x-real-ip': ' 10.0.0.4 ' }), '10.0.0.4');
});

test('ADMIN_PASSWORD: the right password, a missing one (no failure), the per-address lockout and its end', async () => {
  let now = 1_000_000;
  const a = new AdminAuth({ cfg: { adminPassword: 's3cret:with:colons' }, now: () => now });
  assert.equal(a.mode(), 'env');
  assert.equal(a.setupCode, null);
  const L = '192.168.1.10';
  assert.deepEqual(await a.check(req(L, { authorization: basic('s3cret:with:colons') })), { ok: true });
  let r = await a.check(req(L));
  assert.equal(r.status, 401);
  assert.equal(a.info().failures, 0, 'no Authorization header (the browser\'s first request) is not a failure');
  for (let i = 0; i < MAX_FAILURES - 1; i++) assert.equal((await a.check(req(L, { authorization: basic('nope' + i) }))).status, 401);
  assert.deepEqual(await a.check(req(L, { authorization: basic('s3cret:with:colons') })), { ok: true }, 'still under the limit');
  const cap = capture();
  try { r = await a.check(req(L, { authorization: basic('last') })); } finally { cap.restore(); }
  assert.equal(r.status, 401);
  assert.ok(cap.lines.some((l) => /locked out/.test(l)) && !cap.lines.some((l) => l.includes(L)), 'logged, without the address');
  r = await a.check(req(L, { authorization: basic('s3cret:with:colons') }));
  assert.equal(r.status, 429, 'locked: even the right password waits');
  assert.equal(r.code, 'too_many_attempts');
  assert.equal(r.retry_after, LOCK_MS / 1000);
  assert.deepEqual(await a.check(req('192.168.1.11', { authorization: basic('s3cret:with:colons') })), { ok: true }, 'another address is not locked');
  assert.deepEqual(await a.check(req('::ffff:192.168.1.11', { authorization: basic('s3cret:with:colons') })), { ok: true });
  assert.equal(a.info().locked_now, 1);
  now += LOCK_MS + 1;
  assert.deepEqual(await a.check(req(L, { authorization: basic('s3cret:with:colons') })), { ok: true }, 'the lock ends');
  // failures older than the window don't add up
  for (let i = 0; i < MAX_FAILURES - 1; i++) await a.check(req(L, { authorization: basic('x') }));
  now += 16 * 60000;
  await a.check(req(L, { authorization: basic('x') }));
  assert.deepEqual(await a.check(req(L, { authorization: basic('s3cret:with:colons') })), { ok: true }, 'a sliding window');
});

test('first-run setup: the logged one-time code, a scrypt hash in data/admin.json (600), then the stored password', async () => {
  const dir = tmp();
  const cap = capture();
  let a;
  try { a = new AdminAuth({ cfg: { dataDir: dir }, scrypt: FAST }); a.announce(8095); } finally { cap.restore(); }
  assert.equal(a.mode(), 'setup');
  assert.match(a.setupCode, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(cap.lines.filter((l) => l.includes(a.setupCode)).length, 1, 'the code is logged once, at startup');
  assert.ok(cap.lines.some((l) => l.includes('/admin')));
  assert.deepEqual(a.setupInfo(req('192.168.1.10')), { setup: true, code_needed: true, min_length: 8 });
  assert.equal((await a.check(req('192.168.1.10', { authorization: basic('whatever1') }))).code, 'admin_setup');

  const L = req('192.168.1.10');
  await assert.rejects(a.setup(L, { code: 'AAAA-BBBB-CCCC', password: 'longenough' }), (e) => e.status === 403 && e.code === 'bad_setup_code');
  await assert.rejects(a.setup(L, { password: 'longenough' }), (e) => e.code === 'bad_setup_code');
  assert.equal(a.info().failures, 2, 'wrong codes count toward the lockout');
  await assert.rejects(a.setup(L, { code: a.setupCode, password: 'short' }), (e) => e.status === 400 && e.code === 'weak_password');
  await assert.rejects(a.setup(L, { code: a.setupCode, password: 12345678 }), (e) => e.code === 'weak_password');
  await assert.rejects(a.setup(L, { code: a.setupCode, password: 'x'.repeat(257) }), (e) => e.code === 'weak_password');
  assert.equal(a.mode(), 'setup');
  const code = a.setupCode.toLowerCase().replace(/-/g, ' ');            // typed sloppily: case and separators don't matter
  assert.deepEqual(await a.setup(L, { code, password: 'correct horse 42' }), { ok: true });
  assert.equal(a.mode(), 'stored');
  assert.equal(a.setupCode, null, 'one use');
  await assert.rejects(a.setup(L, { code, password: 'another one!' }), (e) => e.status === 409 && e.code === 'already_set');

  const file = path.join(dir, 'admin.json');
  const text = fs.readFileSync(file, 'utf8');
  const rec = JSON.parse(text);
  assert.equal(rec.kdf, 'scrypt');
  assert.equal(Buffer.from(rec.salt, 'base64').length, 16);
  assert.equal(Buffer.from(rec.hash, 'base64').length, 32);
  assert.ok(!text.includes('correct horse'), 'never the password itself');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(file + '.tmp'));

  assert.deepEqual(await a.check(req('192.168.1.10', { authorization: basic('correct horse 42') })), { ok: true });
  assert.deepEqual(await a.check(req('192.168.1.10', { authorization: basic('correct horse 42') })), { ok: true }, 'cached');
  assert.equal((await a.check(req('192.168.1.10', { authorization: basic('correct horse 41') }))).status, 401);

  // a restart reads it back; ADMIN_PASSWORD still wins over it
  const b = new AdminAuth({ cfg: { dataDir: dir } });
  assert.equal(b.mode(), 'stored');
  assert.equal(b.setupCode, null);
  assert.deepEqual(await b.check(req('10.0.0.3', { authorization: basic('correct horse 42', '') })), { ok: true }, 'any user name');
  const c = new AdminAuth({ cfg: { dataDir: dir, adminPassword: 'from-env-1' } });
  assert.equal(c.mode(), 'env');
  assert.equal((await c.check(req('10.0.0.3', { authorization: basic('correct horse 42') }))).status, 401);
  assert.deepEqual(await c.check(req('10.0.0.3', { authorization: basic('from-env-1') })), { ok: true });

  // a damaged file: setup mode again (the new code is in the log)
  fs.writeFileSync(file, '{ not json');
  const d = new AdminAuth({ cfg: { dataDir: dir } });
  assert.equal(d.mode(), 'setup');
  assert.ok(d.setupCode);
});

test('setup from this computer without the code only where loopbackSetup is on (the Windows tray)', async () => {
  const H = { host: '127.0.0.1:8095' };                       // the page the tray opens: http://127.0.0.1:<port>/admin
  const off = new AdminAuth({ cfg: { dataDir: tmp() }, scrypt: FAST });
  assert.equal(off.setupInfo(req('127.0.0.1', H)).code_needed, true, 'Docker: always the code');
  const on = new AdminAuth({ cfg: { dataDir: tmp(), adminSetupLoopback: true }, scrypt: FAST });
  assert.equal(on.setupInfo(req('127.0.0.1', H)).code_needed, false);
  assert.equal(on.setupInfo(req('127.0.0.1', { host: 'localhost:8095', origin: 'http://localhost:8095' })).code_needed, false);
  assert.equal(on.setupInfo(req('::1', { host: '[::1]:8095', origin: 'http://[::1]:8095' })).code_needed, false);
  assert.equal(on.setupInfo(req('192.168.1.10', { host: '192.168.1.20:8095' })).code_needed, true);
  assert.equal(on.setupInfo(req('127.0.0.1', { ...H, 'x-forwarded-for': '192.168.1.10' })).code_needed, true, 'not through a proxy');
  await assert.rejects(on.setup(req('192.168.1.10', { host: '192.168.1.20:8095' }), { password: 'longenough' }), (e) => e.code === 'bad_setup_code');
  assert.deepEqual(await on.setup(req('::1', { host: '[::1]:8095' }), { password: 'longenough' }), { ok: true });
});

test('loopback setup refuses a DNS-rebinding page: its Host or Origin is not a loopback name', async () => {
  const on = new AdminAuth({ cfg: { dataDir: tmp(), adminSetupLoopback: true }, scrypt: FAST });
  const evil = 'rebind.attacker.example:8095';
  for (const h of [{}, { host: evil }, { host: evil, origin: `http://${evil}` }, { host: '127.0.0.1:8095', origin: `http://${evil}` },
    { host: '127.0.0.1:8095', origin: 'null' }, { host: '127.0.0.1.attacker.example:8095' }, { host: 'localhost.attacker.example' }]) {
    assert.equal(on.setupInfo(req('127.0.0.1', h)).code_needed, true, JSON.stringify(h));
  }
  await assert.rejects(on.setup(req('127.0.0.1', { host: evil, origin: `http://${evil}` }), { password: 'attacker-chosen' }),
    (e) => e.status === 403 && e.code === 'bad_setup_code');
  assert.equal(on.mode(), 'setup', 'the password is still unset');
});

test('parallel wrong passwords: at most two hashes per address at once, the rest refused unhashed; one hash per header', async () => {
  const crypto = require('crypto');
  const a = new AdminAuth({ cfg: { dataDir: tmp() }, scrypt: FAST });
  assert.deepEqual(await a.setup(req('192.168.1.10'), { code: a.setupCode, password: 'correct horse 42' }), { ok: true });
  const orig = crypto.scrypt;
  let hashes = 0;
  crypto.scrypt = (...args) => { hashes++; return orig(...args); };
  try {
    const L = '192.168.1.66';
    const burst = await Promise.all(Array.from({ length: 50 }, (_, i) => a.check(req(L, { authorization: basic('guess' + i) }))));
    assert.equal(hashes, 2, 'two scrypt runs for 50 parallel guesses');
    assert.equal(burst.filter((r) => r.status === 401).length, 2);
    assert.equal(burst.filter((r) => r.status === 429 && r.code === 'too_many_attempts').length, 48);
    assert.equal(a.info().failures, 2, 'only the checked ones count');
    // many addresses at once: four hashes in all
    hashes = 0;
    const wide = await Promise.all(Array.from({ length: 40 }, (_, i) => a.check(req('192.168.2.' + (i + 1), { authorization: basic('w' + i) }))));
    assert.equal(hashes, 4);
    assert.equal(wide.filter((r) => r.status === 429).length, 36);
    // the admin page sends several requests at once with the same header: one hash, all let in
    hashes = 0;
    const page = await Promise.all(Array.from({ length: 6 }, () => a.check(req('192.168.1.10', { authorization: basic('correct horse 42') }))));
    assert.ok(page.every((r) => r.ok === true), JSON.stringify(page));
    assert.equal(hashes, 1);
    // nothing is left counted as running
    assert.equal(a.inflightAll, 0);
    assert.equal(a.inflight.size, 0);
    assert.equal(a.verifying.size, 0);
  } finally { crypto.scrypt = orig; }
});

// ------------------------------------------------------------------ http.js wiring
async function server(o = {}) {
  const dir = tmp();
  const cfg = { dataDir: dir, version: '1.1.0', minApp: '1.0.0', tiers: {}, defaultTier: 'high', ...o.cfg };
  const adminAuth = o.adminAuth || new AdminAuth({ cfg, scrypt: FAST });
  const paired = [];
  const ctx = {
    cfg, adminAuth,
    player: { lastPhone: Date.now(), pollRemote: async () => {}, snapshot: () => ({ status: 'stopped' }), st: { active: false, status: 'stopped' },
      genInfo: new Map(), pending: null, heardInfo: () => ({}), syncInfo: () => ({}) },
    auth: o.auth || { verify: () => ({ id: 'dev_1', name: 'test' }), list: () => [], revoke: () => false, pair: (code, name) => { paired.push([code, name]); return { device_id: 'dev_x', secret: 'S', secret_hex: '00' }; } },
    bus: { wait: async () => [] },
    encoders: { warmAll() {}, info: () => ({}) },
    engine: o.engine === undefined ? { connected: false } : o.engine,
    clock: { sample: 0, lead: () => 0, leadMs: 0, frozen: null, pipeBytes: 0, stats: {} },
    started: Date.now(),
    webapi: o.webapi || { info: () => ({}), user: null },
    catalog: { counters: () => ({}), info: async () => ({}) },
    images: { info: () => ({}) }, lyrics: { info: () => ({}) }, membership: { info: () => ({}) },
    jam: { statusInfo: () => ({}), info: () => ({}) }, personal: {}, social: null,
  };
  const srv = createServer(ctx);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const call = (p, { method = 'GET', headers = {}, body, type = 'application/json' } = {}) => new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null && type) h['Content-Type'] = type;
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        let j = null;
        try { j = JSON.parse(text); } catch (e) { j = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, j });
      });
    });
    rq.on('error', reject);
    if (body != null) rq.write(typeof body === 'string' ? body : JSON.stringify(body));
    rq.end();
  });
  return { call, adminAuth, paired, close: () => new Promise((r) => srv.close(r)), port };
}

test('http: the root marker, /v1/status names the bridge, /v1/pair only from allowed addresses and never through a proxy', async () => {
  const s = await server({ cfg: { adminPassword: 'pw-admin-1' } });
  try {
    let r = await s.call('/');
    assert.ok(r.text.startsWith('Encore gateway'), 'the app (ENGateway probe) checks this prefix');
    r = await s.call('/v1/status');
    assert.deepEqual([r.j.gateway.name, r.j.gateway.version, r.j.gateway.min_app], ['Encore Bridge', '1.1.0', '1.0.0']);

    r = await s.call('/v1/pair', { method: 'POST', body: { code: '123456', device_name: 'Alex Example’s iPhone' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(s.paired, [['123456', 'Alex Example’s iPhone']]);
    r = await s.call('/v1/pair', { method: 'POST', headers: { 'X-Forwarded-For': '192.168.1.10' }, body: { code: '123456' } });
    assert.equal(r.status, 403); assert.equal(r.j.error.code, 'proxied');
    r = await s.call('/v1/pair', { method: 'POST', body: '{nope' });
    assert.equal(r.status, 400, 'a broken body is a clean 400');
    assert.equal(s.paired.length, 1);

    // an address outside ADMIN_ALLOW (the internet, through a port forward): pair at home
    s.adminAuth.allowed = () => false;
    r = await s.call('/v1/pair', { method: 'POST', body: { code: '123456' } });
    assert.equal(r.status, 403); assert.equal(r.j.error.code, 'pair_forbidden');
    assert.match(r.j.error.message, /home network/);
    assert.equal(s.paired.length, 1, 'the pairing code was never tried');
    r = await s.call('/admin', { headers: { Authorization: basic('pw-admin-1') } });
    assert.equal(r.status, 403); assert.equal(r.j.error.code, 'forbidden');
    r = await s.call('/admin/listen.aac', { headers: { Authorization: basic('pw-admin-1') } });
    assert.equal(r.status, 403);
  } finally { await s.close(); }
});

test('http: admin with ADMIN_PASSWORD: 401 + realm, JSON-only writes from the page itself, the lockout as 429', async () => {
  const s = await server({ cfg: { adminPassword: 'pw-admin-1' } });
  const A = { Authorization: basic('pw-admin-1') };
  try {
    let r = await s.call('/admin');
    assert.equal(r.status, 401);
    assert.match(r.headers['www-authenticate'], /^Basic realm="Encore Bridge"/);
    r = await s.call('/admin', { headers: A });
    assert.equal(r.status, 200);
    assert.match(r.text, /<title>Encore Bridge<\/title>/);
    r = await s.call('/admin/api/setup');
    assert.deepEqual(r.j, { setup: false, code_needed: false, min_length: 8, platform: 'other' }, 'no password needed to ask, nothing to learn (+ the platform, for the wording of the setup guide)');
    r = await s.call('/admin/api/setup', { method: 'POST', body: { password: 'takeover123' } });
    assert.equal(r.status, 409, 'setup is over: nobody can choose another password');
    r = await s.call('/admin/api/status', { headers: { ...A, 'X-Forwarded-For': '10.0.0.5' } });
    assert.equal(r.j.error.code, 'proxied');
    r = await s.call('/admin/api/status', { headers: A });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.j.admin.mode, 'env');
    assert.equal(r.j.gateway.name, 'Encore Bridge');

    // writes: JSON only, and from the page's own origin when the browser says where it comes from
    r = await s.call('/admin/api/pair-code', { method: 'POST', headers: A, body: 'x=1', type: 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 403); assert.equal(r.j.error.code, 'cross_site');
    r = await s.call('/admin/api/pair-code', { method: 'POST', headers: A, body: '{}', type: 'text/plain' });
    assert.equal(r.j.error.code, 'cross_site');
    r = await s.call('/admin/api/pair-code', { method: 'POST', headers: { ...A, Origin: 'http://evil.example' }, body: {} });
    assert.equal(r.j.error.code, 'cross_site');
    r = await s.call('/admin/api/pair-code', { method: 'POST', headers: { ...A, Origin: 'null' }, body: {} });
    assert.equal(r.j.error.code, 'cross_site');
    r = await s.call('/admin/api/revoke', { method: 'POST', headers: { ...A, Origin: `http://127.0.0.1:${s.port}` }, body: { id: 'nobody' } });
    assert.deepEqual([r.status, r.j], [200, { ok: false }], 'the same origin gets through');
    r = await s.call('/admin/api/nothing', { method: 'POST', headers: A, body: {} });
    assert.equal(r.status, 404);

    // the failure limit
    for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await s.call('/admin/api/status', { headers: { Authorization: basic('wrong' + i) } })).status, 401);
    r = await s.call('/admin/api/status', { headers: A });
    assert.equal(r.status, 429);
    assert.equal(r.j.error.code, 'too_many_attempts');
    assert.equal(r.headers['retry-after'], String(LOCK_MS / 1000));
  } finally { await s.close(); }
});

test('http: first-run setup over the page: setup card, 503 elsewhere, the code, then Basic auth with the new password', async () => {
  const cap = capture();
  let s;
  try {
    s = await server();
    s.adminAuth.announce(8095);
  } finally { cap.restore(); }
  const code = s.adminAuth.setupCode;
  assert.ok(cap.lines.some((l) => l.includes(code)));
  try {
    let r = await s.call('/admin');
    assert.equal(r.status, 200, 'the page opens without a password: it shows the setup card');
    assert.match(r.text, /Choose an admin password/);
    r = await s.call('/admin/api/status');
    assert.equal(r.status, 503); assert.equal(r.j.error.code, 'admin_setup');
    r = await s.call('/admin/api/pair-code', { method: 'POST', body: {} });
    assert.equal(r.status, 503, 'no pairing code before the password');
    r = await s.call('/admin/listen.aac');
    assert.equal(r.status, 503);
    r = await s.call('/admin/api/setup');
    assert.deepEqual(r.j, { setup: true, code_needed: true, min_length: 8, platform: 'other' });
    assert.ok(!r.text.includes(code), 'the code is never in an answer');
    r = await s.call('/admin/api/setup', { method: 'POST', body: JSON.stringify({ code, password: 'my new pass' }), type: 'text/plain' });
    assert.equal(r.j.error.code, 'cross_site', 'another site\'s page can\'t choose the password');
    r = await s.call('/admin/api/setup', { method: 'POST', body: { code: 'WRNG-WRNG-WRNG', password: 'my new pass' } });
    assert.equal(r.status, 403); assert.equal(r.j.error.code, 'bad_setup_code');
    r = await s.call('/admin/api/setup', { method: 'POST', body: { code, password: 'short' } });
    assert.equal(r.status, 400); assert.equal(r.j.error.code, 'weak_password');
    r = await s.call('/admin/api/setup', { method: 'POST', body: { code, password: 'my new pass' } });
    assert.equal(r.status, 200, r.text);
    r = await s.call('/admin');
    assert.equal(r.status, 401, 'from now on the page asks for the password');
    r = await s.call('/admin/api/status', { headers: { Authorization: basic('my new pass') } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.j.admin.mode, 'stored');
    r = await s.call('/admin/api/status', { headers: { Authorization: basic('my old pass') } });
    assert.equal(r.status, 401);
  } finally { await s.close(); }
});

test('http: the Engine sign-in card: signed in (same account or not), signed out, a device code, unreachable; never a name', async () => {
  const engine = (st, ac) => ({ calls: 0, async get(p) { this.calls++; if (p === '/status') return st(); if (p === '/auth/code') return ac(); return { status: 404 }; } });
  const A = { Authorization: basic('pw-admin-1') };
  const cases = [
    [engine(() => ({ status: 200, json: { username: 'Alex.Example', device_name: 'Encore' } })), { user: { id: 'alex.example', name: 'Alex Example' } },
      { state: 'signed_in', same_account: true }],
    [engine(() => ({ status: 200, json: { username: 'sam' } })), { user: { id: 'alex.example' } }, { state: 'signed_in', same_account: false }],
    [engine(() => ({ status: 200, json: { username: 'sam' } })), { user: null }, { state: 'signed_in', same_account: null }],
    [engine(() => ({ status: 204, json: null }), () => ({ status: 204, json: null })), null, { state: 'signed_out' }],
    [engine(() => ({ status: 204, json: null }), () => ({ status: 200, json: { url: 'https://www.spotify.com/pair?code=ABCD1234', code: 'ABCD1234', expires_at: '2026-10-07T12:00:00Z' } })), null,
      { state: 'code', code: 'ABCD1234', url: 'https://www.spotify.com/pair?code=ABCD1234', expires_at: '2026-10-07T12:00:00Z' }],
    [engine(() => ({ status: 204, json: null }), () => ({ status: 200, json: { url: 'javascript:alert(1)//spotify.com', code: 'X1' } })), null,
      { state: 'code', code: 'X1', url: null, expires_at: null }],
    [engine(() => ({ status: 204, json: null }), () => ({ status: 200, json: { url: 'https://spotify.com.evil.example/pair', code: 'X2' } })), null,
      { state: 'code', code: 'X2', url: null, expires_at: null }],
    [engine(() => { throw Object.assign(new Error('Encore\'s player isn\'t reachable.'), { code: 'engine_error' }); }), null, { state: 'unreachable' }],
    [engine(() => ({ status: 500, json: null })), null, { state: 'unreachable', http: 500 }],
    [{ connected: false }, null, { state: 'unknown' }],
  ];
  for (const [eng, web, want] of cases) {
    const s = await server({ cfg: { adminPassword: 'pw-admin-1' }, engine: eng, webapi: { info: () => ({}), ...(web || {}) } });
    try {
      const r = await s.call('/admin/api/engine/signin', { headers: A });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.j, want);
      for (const n of ['Alex', 'alex.example', '"sam"']) assert.ok(!r.text.includes(n), `never the account name: ${r.text}`);
      if (eng && want.state === 'signed_in') {
        await s.call('/admin/api/engine/signin', { headers: A });
        assert.equal(eng.calls, 1, 'memoized for a few seconds');
      }
      assert.equal((await s.call('/admin/api/engine/signin')).status, 401, 'behind the password');
    } finally { await s.close(); }
  }
});

test('log lines name no device and no account: pairing and the phone-log echo', () => {
  const dir = tmp();
  const cap = capture();
  try {
    const auth = new Auth(dir);
    const code = auth.newCode().code;
    const p = auth.pair(code, 'Alex Example’s iPhone');
    assert.equal(p.gateway, 'Encore Bridge');
    const diag = new Diag(dir);
    diag.add({ id: p.device_id, name: 'Alex Example’s iPhone' }, { lines: [{ t: 1, m: 'stream stalled: ran dry' }] });
  } finally { cap.restore(); }
  assert.ok(cap.lines.some((l) => /paired device dev_[0-9a-f]+$/.test(l)), cap.lines.join('\n'));
  assert.ok(cap.lines.some((l) => /phone dev_[0-9a-f]+: stream stalled/.test(l)), cap.lines.join('\n'));
  for (const l of cap.lines) assert.ok(!l.includes('Alex'), l);
});

// Through a port forward anyone can send these: each gets a plain answer at once, and none of them logs a line or
// leaves an unhandled rejection behind (no log flooding from the internet).
test('http: a malformed request target is a 400; a device id named after an Object member is a silent 401', async () => {
  const dir = tmp();
  const auth = new Auth(dir);
  const s = await server({ cfg: { adminPassword: 'pw-admin-1' }, auth });
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const raw = (target) => new Promise((resolve) => {
    const c = require('net').connect({ host: '127.0.0.1', port: s.port });
    let out = '';
    const t = setTimeout(() => { c.destroy(); resolve('no answer'); }, 1500);
    c.on('data', (d) => { out += d; });
    c.on('end', () => { clearTimeout(t); resolve(out); });
    c.on('error', () => { clearTimeout(t); resolve(out || 'error'); });
    c.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
  const cap = capture();
  try {
    for (const target of ['//', 'http://a:99999/', 'http://[x/']) {
      const out = await raw(target);
      assert.match(out, /^HTTP\/1\.1 400 /, `${target}: ${out.slice(0, 60)}`);
      assert.match(out, /"code":"bad_request"/);
    }
    const t = String(Math.round(Date.now() / 1000));
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'dev_nothere']) {
      const r = await s.call('/v1/status', { headers: { 'X-Encore-Device': id, 'X-Encore-Time': t, 'X-Encore-Sig': 'ab'.repeat(32) } });
      assert.equal(r.status, 401, `${id}: ${r.text}`);
      assert.equal(r.j.error.code, 'bad_signature');
    }
    // the real device still gets in
    const { device_id: id, secret } = auth.pair(auth.newCode().code, 'test');
    const sig = require('crypto').createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(`GET\n/v1/status\n${t}\n${require('crypto').createHash('sha256').update(Buffer.alloc(0)).digest('hex')}`).digest('hex');
    const ok = await s.call('/v1/status', { headers: { 'X-Encore-Device': id, 'X-Encore-Time': t, 'X-Encore-Sig': sig } });
    assert.equal(ok.status, 200, ok.text);
    await new Promise((r) => setTimeout(r, 50));
  } finally { cap.restore(); process.off('unhandledRejection', onUnhandled); await s.close(); }
  assert.deepEqual(unhandled, []);
  assert.deepEqual(cap.lines.filter((l) => !/paired device dev_[0-9a-f]+$/.test(l)), [], 'nothing logged');
});
