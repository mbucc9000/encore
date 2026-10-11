'use strict';
// The Windows tray launcher's loopback routes (R3c, http.js; gateway/windows/CONTRACT.md §5): GET /local/v1/status,
// POST /local/v1/shutdown, POST /local/v1/showcase (and POST /local/v1/update, CONTRACT.md §9: hidden the same way here,
// the rest in update-http.test.js). They answer only with ENCORE_LAUNCHER_TOKEN set, only from loopback,
// only with the token header and no Origin; otherwise they are the same plain 404 as any unknown route. Also the
// engine sign-in states an engine of the bridge's own adds (D13), and the admin status additions (platform, the engine
// process, the Phone setup address). A local server with stubs: no engine, no Spotify. Every name below is made up.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer, launcherAllowed, engineSignin } = require('../src/http');
const { AdminAuth } = require('../src/adminauth');

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-launcher-routes-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = 'c0ffee'.repeat(10) + 'beef';                  // 64 hex characters, like the launcher's
const PW = 'pw-admin-launcher';
const AUTH = { Authorization: 'Basic ' + Buffer.from('admin:' + PW).toString('base64') };
const ID = { account: 'alexexample42', accountName: 'Alex Example', phone: 'Sam Sample’s iPhone', dev: 'dev_0123456789abcdef',
  engineUser: 'alex.engine', pc: 'Living Room PC' };
const leaks = (text) => Object.values(ID).filter((v) => text.includes(v));

// engine: {status(), code()} answers for GET /status and GET /auth/code (a function, or a value); sup: a supervisor stub
function engineStub({ status = () => ({ status: 204, json: null }), code = () => ({ status: 204, json: null }) } = {}) {
  const e = { connected: true, calls: [] };
  e.get = async (p) => {
    e.calls.push(p);
    const f = p === '/status' ? status : p === '/auth/code' ? code : () => ({ status: 404, json: null });
    return typeof f === 'function' ? f() : f;
  };
  return e;
}
function supStub(info) {
  return { managed: info.managed !== false, info: () => ({ state: 'running', version: 'encore-1.1.0', expected: 'encore-1.1.0', restarts: 0, managed: true, ...info }) };
}

async function server({ token = TOKEN, engine = engineStub(), supervisor = null, cfg: extra = {}, adminPassword = PW, lanAddress = async () => '192.168.1.20',
  listening = 0, playing = false } = {}) {
  const dir = tmp();
  const cfg = { dataDir: dir, version: '1.1.0', minApp: '1.0.0', tiers: { high: 256 }, defaultTier: 'high', port: 8095, adminPassword, ...extra };
  if (token) Object.defineProperty(cfg, 'launcherToken', { value: token, enumerable: false });
  const shutdowns = [];
  const ctx = {
    cfg, adminAuth: new AdminAuth({ cfg }),
    player: { lastPhone: Date.now(), pollRemote: async () => {}, snapshot: () => ({ status: playing ? 'playing' : 'stopped', remote: { device: ID.pc, type: 'computer' } }),
      st: { active: true, status: playing ? 'playing' : 'stopped' }, genInfo: new Map(), pending: null, heardInfo: () => null, syncInfo: () => ({}) },
    auth: { verify: () => null, list: () => [{ id: ID.dev, name: ID.phone, created: 'x', last_seen: null }], revoke: () => true, newCode: () => ({ code: '123456' }) },
    bus: { wait: async () => [] },
    encoders: { warmAll() {}, info: () => [], listening: () => listening },
    engine,
    clock: { sample: 0, lead: () => 0, leadMs: 10000, frozen: null, pipeBytes: 0, stats: { real: 0, silence: 0 } },
    started: Date.now() - 120000,
    webapi: { ready: true, user: { id: ID.account, name: ID.accountName, product: 'premium' },
      info() { return { configured: true, connected: true, user: this.user }; } },
    catalog: { counters: () => ({}), info: async () => ({}) },
    images: { info: () => ({}) }, lyrics: { info: () => ({}) }, membership: { info: () => ({}) },
    jam: { statusInfo: () => ({}), info: () => ({}) }, personal: {}, social: null,
    supervisor, lanAddress,
    shutdown: (why) => shutdowns.push(why),
  };
  const srv = createServer(ctx);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const call = (p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null) h['Content-Type'] = 'application/json';
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        let j = null;
        try { j = JSON.parse(text); } catch (e) { j = null; }
        resolve({ status: res.statusCode, text, j });
      });
    });
    rq.on('error', reject);
    if (body != null) rq.write(typeof body === 'string' ? body : JSON.stringify(body));
    rq.end();
  });
  const L = { 'X-Encore-Launcher': TOKEN };
  return { call, L, shutdowns, dir, close: () => new Promise((r) => srv.close(r)) };
}

test('the routes hide: no token configured (Docker), no header, a wrong token, an Origin: the same 404 as any unknown route', async () => {
  const unknown = await (async () => { const s = await server(); try { return (await s.call('/nothing-here')).text; } finally { await s.close(); } })();
  const s = await server({ token: '' });
  try {
    for (const [p, m] of [['/local/v1/status', 'GET'], ['/local/v1/shutdown', 'POST'], ['/local/v1/showcase', 'POST'], ['/local/v1/update', 'POST']]) {
      const r = await s.call(p, { method: m, headers: { 'X-Encore-Launcher': TOKEN }, body: m === 'POST' ? { on: true } : undefined });
      assert.equal(r.status, 404, `${p} without a token configured`);
      assert.equal(r.text, unknown);
    }
    assert.deepEqual(s.shutdowns, []);
  } finally { await s.close(); }
  const t = await server();
  try {
    const cases = [{}, { 'X-Encore-Launcher': TOKEN.slice(0, -1) + '0' }, { 'X-Encore-Launcher': TOKEN + '0' }, { 'X-Encore-Launcher': '' },
      { 'X-Encore-Launcher': TOKEN, Origin: 'http://127.0.0.1:8095' }, { 'X-Encore-Launcher': TOKEN, Origin: 'null' }];
    for (const h of cases) {
      for (const [p, m] of [['/local/v1/status', 'GET'], ['/local/v1/shutdown', 'POST'], ['/local/v1/showcase', 'POST'], ['/local/v1/update', 'POST']]) {
        const r = await t.call(p, { method: m, headers: h, body: m === 'POST' ? { on: true } : undefined });
        assert.equal(r.status, 404, `${m} ${p} with ${JSON.stringify(Object.keys(h))}`);
        assert.equal(r.text, unknown);
      }
    }
    assert.deepEqual(t.shutdowns, [], 'nothing was shut down');
    assert.equal((await t.call('/admin/api/showcase', { headers: AUTH })).j.showcase, false, 'nothing was switched');
    // the right token: an unknown /local route and a wrong method are still the plain 404
    assert.equal((await t.call('/local/v2/status', { headers: t.L })).text, unknown);
    assert.equal((await t.call('/local/v1/status', { method: 'POST', headers: t.L, body: {} })).text, unknown);
  } finally { await t.close(); }
});

test('launcherAllowed: loopback only (IPv4, IPv6, IPv4-mapped), the exact token, no Origin', () => {
  const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });
  const h = { 'x-encore-launcher': TOKEN };
  assert.equal(launcherAllowed(req('127.0.0.1', h), TOKEN), true);
  assert.equal(launcherAllowed(req('::1', h), TOKEN), true);
  assert.equal(launcherAllowed(req('::ffff:127.0.0.1', h), TOKEN), true);
  for (const ip of ['192.168.1.20', '203.0.113.9', '127.0.0.2', '::ffff:192.168.1.20', 'fe80::1', '', undefined]) {
    assert.equal(launcherAllowed(req(ip, h), TOKEN), false, String(ip));
  }
  assert.equal(launcherAllowed(req('127.0.0.1', { ...h, 'x-forwarded-for': '127.0.0.1' }), TOKEN), true, 'proxy headers are never considered');
  assert.equal(launcherAllowed(req('127.0.0.1', { ...h, origin: 'https://example.com' }), TOKEN), false);
  assert.equal(launcherAllowed(req('127.0.0.1', h), ''), false, 'no token configured: never');
  assert.equal(launcherAllowed(req('127.0.0.1', {}), TOKEN), false);
  assert.equal(launcherAllowed(req('127.0.0.1', { 'x-encore-launcher': TOKEN.toUpperCase() }), TOKEN), false);
});

test('GET /local/v1/status: every contract field, the right values, and no names, ids or paths', async () => {
  const engine = engineStub({ status: () => ({ status: 200, json: { username: ID.engineUser, device_name: 'Encore' } }) });
  const s = await server({ engine, supervisor: supStub({ restarts: 2 }), listening: 1, playing: true });
  try {
    const r = await s.call('/local/v1/status', { headers: s.L });
    assert.equal(r.status, 200, r.text);
    const j = r.j;
    assert.deepEqual(Object.keys(j).sort(), ['admin', 'bridge', 'contract', 'engine', 'phone_url', 'phones', 'playing', 'setup', 'showcase', 'sign_in', 'spotify',
      'update_request'].sort());
    assert.equal(j.update_request, null, 'no admin-page update request (CONTRACT.md §9; update-http.test.js has the rest)');
    assert.equal(j.contract, 1);
    assert.equal(j.bridge.version, '1.1.0');
    assert.equal(j.bridge.port, 8095);
    assert.ok(j.bridge.uptime_s >= 119 && j.bridge.uptime_s < 200, String(j.bridge.uptime_s));
    assert.deepEqual(j.engine, { state: 'running', version: '1.1.0', expected: '1.1.0', connected: true, signed_in: true, restarts: 2 });
    assert.equal(j.sign_in, null);
    assert.deepEqual(j.admin, { setup_needed: false });
    assert.deepEqual(j.setup, { complete: false }, 'the setup guide (DESIGN-WIZARD.md §2.4): no Client ID in this stub, so not complete');
    assert.deepEqual(j.spotify, { connected: true });
    assert.deepEqual(j.phones, { paired: 1, listening: 1 });
    assert.equal(j.playing, true);
    assert.equal(j.showcase, false);
    assert.equal(j.phone_url, 'http://192.168.1.20:8095');
    assert.deepEqual(leaks(r.text), [], 'no account, device or engine names');
    assert.ok(!r.text.includes(s.dir) && !/[A-Za-z]:\\|\/tmp\//.test(r.text), 'no paths');
  } finally { await s.close(); }
});

test('the status on Docker-like setups and before anything is set up: unmanaged engine, setup needed, nothing known', async () => {
  const s = await server({ engine: engineStub({ status: () => { throw new Error('unreachable'); } }), adminPassword: '', lanAddress: async () => null });
  try {
    const j = (await s.call('/local/v1/status', { headers: s.L })).j;
    assert.deepEqual(j.engine, { state: 'unmanaged', version: null, expected: '1.1.0', connected: true, signed_in: null, restarts: 0 });
    assert.equal(j.admin.setup_needed, true, 'no admin password yet');
    assert.deepEqual(j.setup, { complete: false }, 'setup mode: the guide is not complete');
    assert.equal(j.phone_url, null, 'no address found');
    assert.equal(j.sign_in, null);
  } finally { await s.close(); }
});

test('a device-code sign-in: sign_in passed through (a non-Spotify link dropped), signed_in false, /status not asked', async () => {
  const exp = '2026-10-07T12:10:00Z';
  for (const [url, want] of [['https://www.spotify.com/pair?code=ABCD1234', 'https://www.spotify.com/pair?code=ABCD1234'], ['https://spotify.com.evil.example/pair', null], ['javascript:alert(1)', null]]) {
    const engine = engineStub({ status: () => { throw new Error('a pending device-code sign-in: /status would wait'); }, code: { status: 200, json: { url, code: 'ABCD1234', expires_at: exp } } });
    const s = await server({ engine, supervisor: supStub({}) });
    try {
      const j = (await s.call('/local/v1/status', { headers: s.L })).j;
      assert.deepEqual(j.sign_in, { url: want, code: 'ABCD1234', expires_at: exp });
      assert.equal(j.engine.signed_in, false);
      assert.deepEqual(engine.calls, ['/auth/code'], 'the code first: the engine answers it from its own state');
    } finally { await s.close(); }
  }
});

test('the supervisor\'s states reach the tray and the Engine sign-in card (missing, version mismatch, stopped, starting)', async () => {
  const cases = [
    [{ state: 'missing', version: null }, { state: 'missing', managed: true }],
    [{ state: 'version_mismatch', version: 'encore-1.0.9' }, { state: 'version_mismatch', managed: true, version: '1.0.9', expected: '1.1.0' }],
    [{ state: 'stopped', restarts: 8 }, { state: 'stopped', managed: true }],
  ];
  for (const [info, card] of cases) {
    const engine = engineStub();
    const s = await server({ engine, supervisor: supStub(info) });
    try {
      const j = (await s.call('/local/v1/status', { headers: s.L })).j;
      const full = supStub(info).info();
      assert.equal(j.engine.state, info.state);
      assert.equal(j.engine.version, full.version ? full.version.replace('encore-', '') : null);
      assert.equal(j.engine.signed_in, null);
      const c = await s.call('/admin/api/engine/signin', { headers: AUTH });
      assert.deepEqual(c.j, card);
      assert.deepEqual(engine.calls, [], 'an engine that isn\'t running isn\'t asked');
    } finally { await s.close(); }
  }
  // starting: not answering yet
  const s = await server({ engine: engineStub({ status: () => { throw new Error('refused'); }, code: () => { throw new Error('refused'); } }), supervisor: supStub({ state: 'starting' }) });
  try {
    assert.deepEqual((await s.call('/admin/api/engine/signin', { headers: AUTH })).j, { state: 'starting', managed: true });
    assert.equal((await s.call('/local/v1/status', { headers: s.L })).j.engine.state, 'starting');
  } finally { await s.close(); }
});

test('engineSignin: a Docker engine with device_auth (its /status waits) still shows the code; Docker answers keep their shape', async () => {
  const code = { status: 200, json: { url: 'https://www.spotify.com/pair?code=WXYZ', code: 'WXYZ', expires_at: null } };
  let e = engineStub({ status: () => { throw new Error('timeout'); }, code });
  assert.deepEqual(await engineSignin(e, null, null), { state: 'code', code: 'WXYZ', url: 'https://www.spotify.com/pair?code=WXYZ', expires_at: null });
  assert.deepEqual(e.calls, ['/status', '/auth/code'], 'Docker: /status first, as before');
  e = engineStub({ status: { status: 503, json: null }, code });
  assert.equal((await engineSignin(e, null, null)).state, 'code');
  e = engineStub({ status: { status: 204, json: null } });
  assert.deepEqual(await engineSignin(e, null, null), { state: 'signed_out' });
  e = engineStub({ status: { status: 200, json: { username: ID.engineUser } } });
  assert.deepEqual(await engineSignin(e, { user: { id: ID.engineUser } }, null), { state: 'signed_in', same_account: true });
  assert.deepEqual(e.calls, ['/status'], 'signed in: one request');
  // a supervisor that doesn't manage the engine (Docker) changes nothing
  assert.deepEqual(await engineSignin(engineStub(), null, supStub({ managed: false, state: 'unmanaged' })), { state: 'signed_out' });
  // managed: signed in, signed out (zeroconf configured by hand), unreachable while running
  assert.deepEqual(await engineSignin(engineStub({ status: { status: 200, json: { username: 'x' } } }), null, supStub({})), { state: 'signed_in', managed: true, same_account: null });
  assert.deepEqual(await engineSignin(engineStub(), null, supStub({})), { state: 'signed_out', managed: true });
  assert.deepEqual(await engineSignin(engineStub({ status: { status: 500, json: null } }), null, supStub({})), { state: 'unreachable', managed: true, http: 500 });
});

test('the tray\'s poll never waits on a slow engine once there is an answer', async () => {
  let slow = false;
  const engine = engineStub({
    status: async () => { if (slow) await sleep(2000); return { status: 200, json: { username: 'x' } }; },
  });
  const s = await server({ engine, supervisor: supStub({}) });
  try {
    assert.equal((await s.call('/local/v1/status', { headers: s.L })).j.engine.signed_in, true);
    slow = true;
    await sleep(3100);                                         // the 3 s memo is over: the next look is slow
    const t0 = Date.now();
    const j = (await s.call('/local/v1/status', { headers: s.L })).j;
    assert.ok(Date.now() - t0 < 1000, `answered in ${Date.now() - t0} ms`);
    assert.equal(j.engine.signed_in, true, 'the last answer while the new look runs');
  } finally { await s.close(); }
});

test('POST /local/v1/showcase: the same switch as the admin page; the status hides the address while it is on', async () => {
  const s = await server();
  try {
    let r = await s.call('/local/v1/showcase', { method: 'POST', headers: s.L, body: { on: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.j, { showcase: true });
    assert.equal((await s.call('/admin/api/showcase', { headers: AUTH })).j.showcase, true, 'the admin page sees it');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'showcase.json'), 'utf8')).on, true, 'kept over a restart');
    let j = (await s.call('/local/v1/status', { headers: s.L })).j;
    assert.equal(j.showcase, true);
    assert.equal(j.phone_url, null, 'the address is hidden while Showcase is on');
    const st = (await s.call('/admin/api/status', { headers: AUTH })).j;
    assert.equal(st.phone, null, 'the admin page\'s Phone setup panel too');
    r = await s.call('/local/v1/showcase', { method: 'POST', headers: s.L, body: { on: 'yes' } });
    assert.equal(r.status, 400, 'only true or false');
    r = await s.call('/local/v1/showcase', { method: 'POST', headers: s.L, body: 'not json' });
    assert.equal(r.status, 400);
    r = await s.call('/admin/api/showcase', { method: 'POST', headers: AUTH, body: { on: false } });
    j = (await s.call('/local/v1/status', { headers: s.L })).j;
    assert.equal(j.showcase, false, 'switched off on the admin page: the tray sees it');
    assert.equal(j.phone_url, 'http://192.168.1.20:8095');
  } finally { await s.close(); }
});

test('POST /local/v1/shutdown: 202 {ok:true}, then the graceful stop (after the answer is out)', async () => {
  const s = await server();
  try {
    const r = await s.call('/local/v1/shutdown', { method: 'POST', headers: s.L, body: {} });
    assert.equal(r.status, 202);
    assert.deepEqual(r.j, { ok: true });
    for (let i = 0; i < 20 && !s.shutdowns.length; i++) await sleep(10);
    assert.deepEqual(s.shutdowns, ['the launcher asked']);
  } finally { await s.close(); }
});

test('the admin status: platform, the engine process and the Phone setup address; the setup answer says Windows only on Windows', async () => {
  let s = await server({ supervisor: supStub({ restarts: 1 }), cfg: { windows: true, launcher: true } });
  try {
    const st = (await s.call('/admin/api/status', { headers: AUTH })).j;
    assert.deepEqual(st.platform, { windows: true, engine: 'managed', launcher: true });
    assert.deepEqual(st.engine_process, { state: 'running', version: '1.1.0', expected: '1.1.0', restarts: 1, managed: true });
    assert.deepEqual(st.phone, { address: '192.168.1.20', port: 8095, url: 'http://192.168.1.20:8095' });
    const su = (await s.call('/admin/api/setup')).j;
    assert.equal(su.windows, true);
  } finally { await s.close(); }
  s = await server({ token: '' });
  try {
    const st = (await s.call('/admin/api/status', { headers: AUTH })).j;
    assert.deepEqual(st.platform, { windows: false, engine: 'separate', launcher: false });
    assert.equal(st.engine_process, null);
    assert.deepEqual(await s.call('/admin/api/setup').then((r) => r.j), { setup: false, code_needed: false, min_length: 8, platform: 'other' }, 'Docker: the same answer as before (+ the platform)');
  } finally { await s.close(); }
});

test('Windows first run: this computer (loopback) chooses the admin password without the setup code', async () => {
  const s = await server({ adminPassword: '', cfg: { windows: true, adminSetupLoopback: true } });
  try {
    let r = await s.call('/admin/api/setup');
    assert.deepEqual(r.j, { setup: true, code_needed: false, min_length: 8, windows: true, platform: 'windows' });
    r = await s.call('/admin/api/setup', { method: 'POST', body: { password: 'a long new password' } });
    assert.equal(r.status, 200, r.text);
    r = await s.call('/admin/api/status', { headers: { Authorization: 'Basic ' + Buffer.from('me:a long new password').toString('base64') } });
    assert.equal(r.status, 200);
    assert.equal((await s.call('/local/v1/status', { headers: s.L })).j.admin.setup_needed, false);
  } finally { await s.close(); }
});
